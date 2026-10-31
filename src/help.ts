import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Command {
  name: string;
  usage: string;
  summary: string;
}

export const commands: Command[] = [
  { name: 'build', usage: 'mill build [--force | --move] [--json]', summary: 'Create or refresh .mill/config.yaml from house defaults; --force overwrites it; --move moves the millyard here from another worktree of the project.' },
  { name: 'run', usage: 'mill run [--foreground | --background] [--json]', summary: 'Activate the drafted run and hand it to the shared scheduler, starting the scheduler if none is running, then return; the scheduler keeps the run moving as tickets unblock and slots free up, sharing capacity fairly with other active runs. Repeating it is harmless and keeps a pause; to retry after a pause, stop the run and start it again. --background is the same as the default. --foreground instead coordinates this run in the terminal, retrying paused work, until it finishes, has no runnable work, pauses, or is stopped.' },
  { name: 'run draft', usage: 'mill run draft (<numbers...> | --label <label> | --spec <number>) [--include-closed] [--replace] [--json]', summary: 'Append new tickets to the ongoing run, leaving existing work and execution intent unchanged; duplicate tickets are left alone. A completed run is archived and a new inactive run is drafted. Closed tickets are left out unless --include-closed is given, which never reopens them. --replace is only for an inactive draft with no working or logjam tickets; a run in progress can never be replaced.' },
  { name: 'run status', usage: 'mill run status [--json]', summary: 'Show whether the run is inactive, active, paused, stopped or completed, whether the scheduler is running, and only the queued, working, and logjam tickets.' },
  { name: 'pick', usage: 'mill pick (<n> | --clear) [--json]', summary: 'Prefer one ready ticket in the current run at its next dispatch opportunity; another pick replaces it. --clear cancels the pending pick. Picking never activates a run, interrupts working tickets, or changes shared slot limits and project fairness.' },
  { name: 'run log', usage: 'mill run log <n> [--json]', summary: 'Print every step Mill took on a ticket, oldest first, with each report in full.' },
  { name: 'run once', usage: 'mill run once [--json]', summary: 'Dispatch one pass and return; detached workers continue. It never activates the run.' },
  { name: 'run stop', usage: 'mill run stop [<n>] [--json]', summary: 'With <n>, ask a working ticket to stop once its active stage finishes safely. Without it, stop the run: no new tickets start until mill run starts it again.' },
  { name: 'run clear', usage: 'mill run clear [--json]', summary: 'Discard the current run file without archiving: membership, checkpoints and the run log are lost. Missing runs are a successful no-op. Refuses active/paused runs, working tickets, live or uncertain workers/locks and pending tracker writes. First mill run stop, then mill run stop <n> for each working ticket and wait for safe boundaries and worker exit. Keeps history, attempt records, logs, config, hooks, environment files, worktrees, branches, tracker content and registration. No confirmation or force bypass; this is not reset, stop or draft replacement.' },
  { name: 'run close', usage: 'mill run close <n> [--json]', summary: 'Close a ticket in the run.' },
  { name: 'run answer', usage: 'mill run answer <n> [text] [--implementer] [--json]', summary: 'Answer a logjammed ticket and requeue it. In an active run the shared scheduler picks it up; an inactive or stopped run stays as it is. --implementer retries a not-reproduced repair.' },
  { name: 'run approve-tests', usage: 'mill run approve-tests <n> [--json]', summary: "Accept a logjammed ticket's committed tests as its new protected baseline; answering it then resumes at review." },
  { name: 'run waive', usage: 'mill run waive <n> <item> --reason <text> [--json]', summary: "Waive one item of a ticket's acceptance checklist, such as AC2, with the reason; a review may then pass it unproved. Only a person waives, and the run log keeps who did and why. It never bypasses the tests, review or CI." },
  { name: 'run notify', usage: 'mill run notify [--json]', summary: 'Send each new event to the executable .mill/notify.sh, once, with the event as JSON on stdin: a ticket needing a decision, a ticket completed, or a working ticket with no recorded progress for longer than role_timeout. What was sent is kept with the run, so a repeated poll sends nothing new. The shared scheduler sends them too while it serves the run. Without the hook it does nothing.' },
  { name: 'run refresh', usage: 'mill run refresh <n> [--json]', summary: 'Fetch the latest text and comments of a drafted ticket from the tracker without resetting its work or state. Allowed for queued, blocked or logjam tickets; stop a working ticket first. Rebuilds acceptance and keeps waivers only on unchanged items; status and log show the refresh.' },
  { name: 'run reset', usage: 'mill run reset <n> [--json]', summary: 'Fetch the latest ticket text and comments, then start it over: delete its agent comments, worktree, branches and saved progress, and requeue it. Keeps human waivers on unchanged acceptance items. A failed tracker fetch leaves the saved ticket and work untouched.' },
  { name: 'record export', usage: 'mill record export [--json]', summary: "Print every retained delivery attempt as JSON, oldest first: its ancestry, heads, completion, verification policy, environment, results and findings. Figures nothing supplied read unknown. It only reads; reset and redraft keep the records." },
  { name: 'record report', usage: 'mill record report [--json]', summary: 'Compare the retained attempts: counts by completion, review bounces, wrong-test corrections, flakes, environment failures and human actions, with figures nothing supplied shown as unknown.' },
  { name: 'record note', usage: 'mill record note <n> (--minutes <m> | --defect <ref>) [--json]', summary: "Note on the ticket's latest attempt the minutes a person actively spent on it, which add up, or link a defect found after delivery." },
  { name: 'record forget', usage: 'mill record forget (--ticket <n> | --before <YYYY-MM-DD> | --all) [--json]', summary: "Delete attempt records for good: one ticket's, those that ended before a date, or all of them. Nothing else removes them." },
  { name: 'release handoff', usage: 'mill release handoff <n> [--json]', summary: "After a ticket merges, report what a release operator needs: the delivered revision, the artifact check, acceptance evidence and waivers, the project's release steps from release.steps with each one verified, waived, pending or not applicable, and what recovery can and cannot undo. Release-ready only when nothing applicable is pending. It only reads; Mill never deploys." },
  { name: 'team tail', usage: 'mill team tail <n> [--no-follow] [--json]', summary: "Follow the ticket's newest role log; --no-follow prints it and returns." },
  { name: 'team review', usage: 'mill team review <n> [--json]', summary: 'Review an existing ticket worktree, including handwritten work.' },
  { name: 'team run', usage: 'mill team run <n> [--json]', summary: 'Run or resume one drafted ticket through the team workflow.' },
  { name: 'integrate', usage: 'mill integrate <n> [--json]', summary: 'Integrate clean, review-approved ticket work.' },
  { name: 'worktree create', usage: 'mill worktree create <n> [--json]', summary: 'Create or reuse a ticket worktree; when it needs setup, check .mill/fixtures.json, then run setup and prepare.' },
  { name: 'worktree prepare', usage: 'mill worktree prepare <n> [--json]', summary: "Run .mill/prepare.sh to bring the ticket's site up to date with its current commit, without reseeding, and report its environment, URL and readiness." },
  { name: 'worktree remove', usage: 'mill worktree remove <n> [--json]', summary: 'Run teardown and remove a clean worktree, retaining unmerged branches.' },
  { name: 'worktree gc', usage: 'mill worktree gc [--json]', summary: 'Clean up worktrees for locally done tickets.' },
  { name: 'tickets comment', usage: 'mill tickets comment <n> <text> [--stage <stage>] [--json]', summary: 'Comment on a ticket in the run; --stage records a stage report.' },
  { name: 'tickets label', usage: 'mill tickets label <n> <label> [--remove] [--json]', summary: 'Add or, with --remove, remove a label on a ticket in the run.' },
  { name: 'board', usage: 'mill board [--port <n>] [--json]', summary: 'Serve a live page of every run on this machine, with controls to stop, answer, reset and close tickets and to start or stop a run; --json prints one snapshot.' },
  { name: 'scheduler status', usage: 'mill scheduler status [--json]', summary: 'Show whether the shared scheduler is running, its log, and the state of every registered run.' },
  { name: 'scheduler stop', usage: 'mill scheduler stop [--json]', summary: 'Stop the shared scheduler after its current pass; working tickets keep going and the next mill run starts it again.' },
  { name: 'skills refresh', usage: 'mill skills refresh [--json]', summary: 'Explicitly refresh installer-owned global Sawmill skills after consent, preserving customized or unverified copies and unrelated skills. Requires an interactive terminal. Reload skills in an existing conversation or start a fresh session: replacing files cannot update instructions already loaded.' },
  { name: 'update', usage: 'mill update <source> [--json]', summary: "Rebuild and install mill from a local Sawmill checkout you choose: run npm ci and npm run build in a staged copy, check it, then replace this installation's runtime and role prompts together. It never fetches, pulls, switches branches or changes the checkout; uncommitted edits are built and the build is marked dirty. The shared scheduler admits no new tickets meanwhile, working tickets finish on the old build first, and a scheduler that was running restarts on the new one. Every run keeps its state. A failed build leaves the previous installation in place." },
];

const options = [
  '  --json       Print machine-readable output.',
  '  -h, --help   Show help for mill or a command.',
  '  --version    Print the mill version, its build identity and the executable it runs.',
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

/** The package version of the installation at `root`. */
export function version(root: string): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}
