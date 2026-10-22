#!/usr/bin/env node
import { runCli } from './cli.js';

const args = process.argv.slice(2);
const controller = new AbortController();
const interrupt = () => controller.abort();
const roleCommand = args[0] === 'team' && ['review', 'tail'].includes(args[1] ?? '');
if (roleCommand) {
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
}
try { process.exitCode = await runCli(args, { signal: controller.signal }); }
finally {
  if (roleCommand) {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
