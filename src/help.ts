import { readFileSync } from 'node:fs';

export interface Command {
  name: string;
  usage: string;
  summary: string;
}

export const commands: Command[] = [
  { name: 'build', usage: 'mill build [--force | --move] [--json]', summary: 'Create or refresh .mill/config.yaml from house defaults; --force overwrites it; --move moves the millyard here from another worktree of the project.' },
  { name: 'run', usage: 'mill run [--foreground] [--json]', summary: 'Dispatch the drafted run in the background and return; --foreground waits until it finishes, has no runnable work, or pauses.' },
  { name: 'run draft', usage: 'mill run draft (<numbers...> | --label <label> | --spec <number>) [--replace] [--json]', summary: 'Select tickets for the run; --replace discards the saved run.' },
  { name: 'run status', usage: 'mill run status [--json]', summary: 'Show queued, blocked, working, done, and logjam tickets.' },
  { name: 'run once', usage: 'mill run once [--json]', summary: 'Dispatch one pass and return; detached workers continue.' },
  { name: 'run stop', usage: 'mill run stop <n> [--json]', summary: 'Ask a working ticket to stop once its active stage finishes safely.' },
  { name: 'run close', usage: 'mill run close <n> [--json]', summary: 'Close a ticket in the run.' },
  { name: 'run answer', usage: 'mill run answer <n> [text] [--implementer] [--json]', summary: 'Answer a logjammed ticket and requeue it; --implementer retries a not-reproduced repair.' },
  { name: 'team tail', usage: 'mill team tail <n> [--no-follow] [--json]', summary: "Follow the ticket's newest role log; --no-follow prints it and returns." },
  { name: 'team review', usage: 'mill team review <n> [--json]', summary: 'Review an existing ticket worktree, including handwritten work.' },
  { name: 'team run', usage: 'mill team run <n> [--json]', summary: 'Run or resume one drafted ticket through the team workflow.' },
  { name: 'integrate', usage: 'mill integrate <n> [--json]', summary: 'Integrate clean, review-approved ticket work.' },
  { name: 'worktree create', usage: 'mill worktree create <n> [--json]', summary: 'Create or reuse a ticket worktree and run setup when needed.' },
  { name: 'worktree remove', usage: 'mill worktree remove <n> [--json]', summary: 'Run teardown and remove a clean worktree, retaining unmerged branches.' },
  { name: 'worktree gc', usage: 'mill worktree gc [--json]', summary: 'Clean up worktrees for locally done tickets.' },
  { name: 'tickets comment', usage: 'mill tickets comment <n> <text> [--stage <stage>] [--json]', summary: 'Comment on a ticket in the run; --stage records a stage report.' },
  { name: 'tickets label', usage: 'mill tickets label <n> <label> [--remove] [--json]', summary: 'Add or, with --remove, remove a label on a ticket in the run.' },
  { name: 'board', usage: 'mill board [--port <n>] [--json]', summary: 'Serve a live, read-only page of every run on this machine; --json prints one snapshot.' },
];

const options = [
  '  --json       Print machine-readable output.',
  '  -h, --help   Show help for mill or a command.',
  '  --version    Print the mill version.',
];

export function usage(name: string): string {
  return `Usage: ${commands.find(command => command.name === name)!.usage}`;
}

/** The longest command whose words start the given arguments. */
export function findCommand(words: string[]): Command | undefined {
  return commands
    .filter(command => command.name.split(' ').every((word, index) => words[index] === word))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

export function shortHelp(): string {
  return "Usage: mill <command> [options]\nRun 'mill --help' to see commands.";
}

export function unknownCommand(words: string[]): string {
  return `Unknown command '${words.join(' ')}'. Run 'mill --help' to see commands.`;
}

export function helpText(words: string[]): string | undefined {
  if (!words.length) {
    const width = Math.max(...commands.map(command => command.name.length));
    return ['Usage: mill <command> [options]', '', 'Commands:',
      ...commands.map(command => `  mill ${command.name.padEnd(width)}  ${command.summary}`),
      '', 'Options:', ...options, '',
      "Run 'mill <command> --help' for a command's usage.",
      'Exit codes: 0 success, 1 operational failure, 2 usage or configuration error.'].join('\n');
  }
  const command = findCommand(words);
  if (!command) return undefined;
  return [`Usage: ${command.usage}`, '', command.summary, '', 'Options:', ...options.slice(0, 2)].join('\n');
}

export function version(): string {
  return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}
