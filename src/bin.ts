#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { runCli } from './cli.js';

const args = process.argv.slice(2);
const controller = new AbortController();
const interrupt = () => controller.abort();
const roleCommand = args[0] === 'team' && ['review', 'tail'].includes(args[1] ?? '');
if (roleCommand) {
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
}
process.env.MILL_WORKER_TOKEN ??= randomUUID();
// A background parent (src/run-background.ts) waits on IPC for the loop lock.
const onRunLocked = process.send ? () => { process.send!({ type: 'locked' }); } : undefined;
try { process.exitCode = await runCli(args, { signal: controller.signal, onRunLocked }); }
finally {
  if (roleCommand) {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
