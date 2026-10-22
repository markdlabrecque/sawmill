import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout } from 'node:timers/promises';
import { CliError } from './errors.js';

interface Log { path: string; role: string; round: number; modified: number; running: boolean }
async function newest(directory: string): Promise<Log | undefined> {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  const logs = await Promise.all(names.filter(name => /^(test-writers|implementer|reviewer)-\d+\.jsonl$/.test(name)).map(async name => {
    const path = join(directory, name);
    const match = /^(.*)-(\d+)\.jsonl$/.exec(name)!;
    let running = false;
    try {
      const meta = JSON.parse(await readFile(`${path}.meta.json`, 'utf8'));
      if (meta.running && Number.isSafeInteger(meta.pid) && meta.pid > 0) { process.kill(meta.pid, 0); running = true; }
    } catch { /* Old logs and exited processes remain readable. */ }
    return { path, role: match[1]!, round: Number(match[2]), modified: (await stat(path)).mtimeMs, running };
  }));
  return logs.sort((a, b) => Number(b.running) - Number(a.running) || b.modified - a.modified || b.round - a.round)[0];
}

function readable(event: unknown): string {
  if (!event || typeof event !== 'object') return JSON.stringify(event);
  const e = event as Record<string, any>;
  if (e.type === 'result') return typeof e.result === 'string' ? e.result : `Result: ${e.subtype} ${JSON.stringify(e.errors ?? [])}`;
  if (Array.isArray(e.message?.content)) return e.message.content.map((block: Record<string, any>) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool_use') return `Tool: ${block.name} ${JSON.stringify(block.input ?? {})}`;
    if (block.type === 'tool_result') return `Tool result${block.is_error ? ' (error)' : ''}: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`;
    return `[${block.type}]`;
  }).join('\n');
  if (e.type === 'system' && e.subtype === 'init') return `Session: ${e.session_id ?? '(unknown)'}; model: ${e.model ?? '(unknown)'}`;
  // Other runtimes can still be inspected before a richer renderer is added.
  return JSON.stringify(event);
}

export async function tailTicket(cwd: string, number: number, options: { json: boolean; follow: boolean; stdout: (text: string) => void; signal?: AbortSignal }) {
  const directory = join(cwd, '.mill/logs', String(number));
  const cursors = new Map<string, { offset: number; decoder: StringDecoder; pending: string }>();
  let selected: string | undefined;
  const emit = (value: object, text: string) => options.stdout((options.json ? JSON.stringify(value) : text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')) + '\n');
  async function drain(log: Log, stream: 'stdout' | 'stderr', flush: boolean) {
    const path = stream === 'stdout' ? log.path : log.path.replace(/\.jsonl$/, '.stderr.log');
    let handle;
    try { handle = await open(path, 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const cursor = cursors.get(path) ?? { offset: 0, decoder: new StringDecoder('utf8'), pending: '' };
    cursors.set(path, cursor);
    const line = (text: string) => {
      if (!text) return;
      let event: unknown;
      if (stream === 'stdout') { try { event = JSON.parse(text); } catch { /* Keep malformed vendor lines inspectable. */ } }
      emit({ role: log.role, round: log.round, stream, ...(event === undefined ? { text } : { event }) }, event === undefined ? `${stream === 'stderr' ? '[stderr] ' : ''}${text}` : readable(event));
    };
    try {
      const bytes = Buffer.alloc(65536);
      for (;;) {
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, cursor.offset);
        if (!bytesRead) break;
        cursor.offset += bytesRead;
        cursor.pending += cursor.decoder.write(bytes.subarray(0, bytesRead));
        let end: number;
        while ((end = cursor.pending.indexOf('\n')) >= 0) { line(cursor.pending.slice(0, end).replace(/\r$/, '')); cursor.pending = cursor.pending.slice(end + 1); }
      }
      if (flush) { cursor.pending += cursor.decoder.end(); if (cursor.pending) line(cursor.pending); cursor.pending = ''; cursor.decoder = new StringDecoder('utf8'); }
    } finally { await handle.close(); }
  }
  do {
    const log = await newest(directory);
    if (!log && !selected) throw new CliError(`No role logs for ticket #${number}.`);
    if (log) {
      if (selected !== log.path) {
        selected = log.path;
        emit({ type: 'log', ticket: number, role: log.role, round: log.round, path: log.path }, `Following ${log.role} round ${log.round}: ${log.path}`);
      }
      await drain(log, 'stdout', !options.follow || !log.running);
      await drain(log, 'stderr', !options.follow || !log.running);
    }
    if (!options.follow || options.signal?.aborted) return;
    try { await setTimeout(100, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal?.aborted) throw error; }
  } while (!options.signal?.aborted);
}
