#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { runCli } from './cli.js';

const args = process.argv.slice(2);
const controller = new AbortController();
const interrupt = () => controller.abort();
// An interrupted update cancels its drain and releases dispatch instead of dying mid-swap.
const roleCommand = (args[0] === 'team' && ['review', 'tail'].includes(args[1] ?? '')) || args[0] === 'board' || args[0] === 'update';
if (roleCommand) {
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
}
process.env.MILL_WORKER_TOKEN ??= randomUUID();
try { process.exitCode = await runCli(args, { signal: controller.signal }); }
finally {
  if (roleCommand) {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
