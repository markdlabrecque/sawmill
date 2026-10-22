import { runCli, ticketWriter } from './cli.js';
import { loadConfig } from './config.js';
import { readRun } from './run-store.js';
import { readSlot, releaseSlot } from './slots.js';
import type { TeamResult } from './team-runner.js';
import { recordWorker, transition } from './transitions.js';
import { stopDescendants } from './process-ownership.js';

// Internal process entry point, deliberately not a user-selectable runtime command.
const [number, runId, token, home] = process.argv.slice(2);
const ticket = Number(number), cwd = process.cwd();
if (!process.send || !runId || !token || !home || !Number.isSafeInteger(ticket) || ticket < 1) throw new Error('Team worker requires a dispatcher IPC handshake.');
const started = await new Promise<boolean>(resolve => {
  process.once('disconnect', () => resolve(false));
  process.once('message', message => {
    const event = message as { type?: string; token?: string };
    resolve(event.type === 'start' && event.token === token);
  });
  process.send!({ type: 'ready', token });
});
if (started) {
  const snapshot = readRun(cwd);
  const row = snapshot.tickets.find(row => row.number === ticket);
  const owner = row?.worker;
  const slot = owner ? readSlot(owner.slot) : null;
  if (snapshot.run.id !== runId || row?.state !== 'working' || owner?.token !== token || owner.pid !== process.pid || slot?.token !== token || slot.pid !== process.pid) throw new Error('Team worker has no committed ownership.');
  await new Promise<void>((resolve, reject) => process.send!({ type: 'started', token }, error => error ? reject(error) : resolve()));
  if (process.connected) process.disconnect?.();
  let result: TeamResult;
  try {
    let output = '';
    const code = await runCli(['team', 'run', number!, '--json'], { cwd, home, stdout: value => { output += value; } });
    const value = JSON.parse(output);
    result = value.outcome ? value as TeamResult : { outcome: 'infrastructure', ticket, stage: 'team-launch', error: value.message ?? `Team CLI exited ${code}: ${output}` };
  } catch (error) { result = { outcome: 'infrastructure', ticket, stage: 'team-launch', error: String(error) }; }
  {
    const latestOwner = readRun(cwd).tickets.find(row => row.number === ticket)?.worker;
    if (latestOwner?.token !== token) throw new Error('Worker ownership changed before cleanup.');
    if (latestOwner.processToken && process.platform === 'linux') await stopDescendants(latestOwner.processToken, [...latestOwner.processes ?? [], { pid: process.pid, processStart: latestOwner.processStart, group: true }]);
    const current = readRun(cwd);
    const row = current.tickets.find(row => row.number === ticket);
    if (current.run.id === runId && row?.worker?.token === token && row.state === 'working') {
      const config = await loadConfig(cwd, home);
      if (!config.valid) throw new Error('Worker config became invalid; recovery required.');
      await transition(cwd, config.project, ticketWriter({}, config.project, cwd), ticket, {
        state: 'logjam', reason: result.outcome === 'stopped' ? 'stopped' : 'environment', stage: result.stage,
        report: { stage: result.outcome === 'stopped' ? 'stopped' : 'infrastructure', details: result.error ?? result.reason ?? 'Team exited without terminal state.' },
      });
    }
    if (recordWorker(cwd, ticket, { ...latestOwner, status: 'finished', finished: new Date().toISOString(), result })) releaseSlot({ path: owner.slot, token });
  }
}
