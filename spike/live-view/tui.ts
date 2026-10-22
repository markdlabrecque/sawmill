// SPIKE output for #28. Not shipped, disposable.
// Terminal option: plain ANSI, no dependencies (no Go on this machine, so no Charm).
//   node spike/live-view/tui.ts [millyard...]      q or Ctrl-C quits
import { homedir } from 'node:os';
import { discover, readView, LANES, SHORT, type View, type ViewTicket } from './model.ts';

const extra = process.argv.slice(2);
const out = process.stdout;
const E = '\x1b[';
const paint = (code: string, text: string) => `${E}${code}m${text}${E}0m`;
const dim = (t: string) => paint('2', t), cyan = (t: string) => paint('36', t), green = (t: string) => paint('32', t), red = (t: string) => paint('31', t), yellow = (t: string) => paint('33', t), bold = (t: string) => paint('1', t);
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let view: View = readView(discover(homedir(), extra));
let frame = 0;
const pos = new Map<string, number>();
const bounces = new Map<string, number>();
const flash = new Map<string, number>();
setInterval(() => { view = readView(discover(homedir(), extra)); }, 500);

function detail(t: ViewTicket): string {
  if (t.state === 'working') return cyan(`${t.role ?? t.stage ?? ''}${t.bounces ? ` · round ${t.bounces + 1}` : ''} · ${t.seconds ?? 0}s`);
  if (t.state === 'blocked') return yellow(`blocked by ${t.blockers.map(n => `#${n}`).join(', ')}`);
  if (t.state === 'logjam') return red(`logjam: ${t.reason ?? ''}${t.stage ? ` at ${t.stage}` : ''}`);
  if (t.state === 'done') return green('merged');
  return dim('queued');
}

function render(): string {
  const cols = out.columns || 80;
  const wide = cols >= 96;
  const labels = wide ? LANES : SHORT;
  const cell = wide ? 10 : Math.max(3, Math.floor((cols - 6) / 10));
  const indent = 5;
  const lines: string[] = [bold(dim(' mill live')) + dim(`  ${view.projects.length} project(s) · ${new Date(view.at).toLocaleTimeString()} · q quits`), ''];
  for (const p of view.projects) {
    const counts = new Map<string, number>();
    for (const t of p.tickets) counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
    lines.push(` ${bold(p.name)}  ${dim(p.error ? 'unreadable' : [...counts].map(([k, v]) => `${v} ${k}`).join(' · '))}`);
    if (wide) lines.push(dim(`   ${p.millyard}`));
    for (const t of p.tickets) {
      const key = `${p.millyard}#${t.number}`;
      const current = pos.get(key) ?? t.lane;
      const next = Math.abs(t.lane - current) < 0.05 ? t.lane : current + (t.lane - current) * 0.25;
      pos.set(key, next);
      if ((bounces.get(key) ?? t.bounces) < t.bounces) flash.set(key, frame + 8);
      bounces.set(key, t.bounces);
      const title = t.title.length > cols - 40 ? t.title.slice(0, Math.max(8, cols - 43)) + '…' : t.title;
      lines.push(`   ${dim(`#${t.number}`)} ${title}${t.bounces ? yellow(` ↺${t.bounces}`) : ''}${t.stopRequested ? dim(' stop') : ''}  ${detail(t)}`);
      const track = labels.map((l, i) => (i < t.lane ? dim(l) : l).padEnd(cell + (i < t.lane ? 8 : 0), ' ')).join('');
      lines.push(' '.repeat(indent) + track);
      const x = indent + Math.round(next * cell) + Math.floor(Math.min(labels[Math.round(next)]!.length, cell) / 2);
      const glyph = t.state === 'done' ? green('✔') : t.state === 'logjam' ? (frame % 10 < 5 ? red('✖') : red(dim('✖'))) : t.state === 'blocked' ? yellow('◌') : t.state === 'working' ? cyan(`◉${SPIN[frame % SPIN.length]}`) : dim('○');
      const flashing = (flash.get(key) ?? 0) > frame && frame % 2 === 0;
      lines.push(' '.repeat(Math.max(0, x)) + (flashing ? yellow('↺') : glyph));
    }
    lines.push('');
  }
  if (!view.projects.length) lines.push(dim('   No runs found. Slot leases and ~/.local/state/sawmill/millyards are empty.'));
  return lines.map(l => l + `${E}K`).join('\n');
}

const restore = () => { out.write(`${E}?25h${E}?1049l`); process.exit(0); };
out.write(`${E}?1049h${E}?25l`);
process.on('SIGINT', restore); process.on('SIGTERM', restore);
if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', d => { if (d.toString() === 'q' || d[0] === 3) restore(); }); }
setInterval(() => { frame++; out.write(`${E}H` + render() + `\n${E}J`); }, 100);
