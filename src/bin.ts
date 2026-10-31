#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { offerSkills } from './agent-skills.js';
import { packageRoot } from './build-identity.js';
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
// Only a person at a terminal is asked; scripts, workers and --json output never see the question.
const informational = !args.length || args.some(arg => ['--json', '--help', '-h', '--version'].includes(arg));
if (process.stdin.isTTY && process.stdout.isTTY && !informational && !['skills', 'update'].includes(args[0] ?? '')) {
  const ask = async (question: string) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    prompt.once('SIGINT', () => process.exit(130));
    try { return await prompt.question(question); }
    finally { prompt.close(); }
  };
  await offerSkills({ root: packageRoot, home: homedir(), ask, stdout: text => process.stdout.write(text) })
    .catch((error: Error) => process.stderr.write(`Could not check Sawmill's agent skills: ${error.message}\n`));
}
try { process.exitCode = await runCli(args, { signal: controller.signal }); }
finally {
  if (roleCommand) {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
