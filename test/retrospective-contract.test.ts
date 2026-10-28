import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// These are instruction contracts, like learn-skill.test.ts: the shipped
// skills are the user-facing workflow. No host/model evaluation is required.
async function skill(name: string): Promise<string> {
  const path = new URL(`../../plugins/sawmill/skills/${name}/SKILL.md`, import.meta.url);
  return (await readFile(path, 'utf8')).replace(/\s+/g, ' ');
}

function section(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `${heading} section exists`);
  const end = body.indexOf(' ## ', start + 3);
  return body.slice(start, end < 0 ? undefined : end);
}

function requires(body: string, checks: Array<[RegExp, string]>): void {
  for (const [pattern, message] of checks) assert.match(body, pattern, message);
}

test('Foreman finishes with its report before offering one scoped opt-in retrospective', async () => {
  const finish = section(await skill('foreman'), 'Finish');
  requires(finish, [
    [/\.mill\/logs\/foreman-/, 'retain the run log'],
    [/count of problems solved and escalated/i, 'retain solved/escalated counts'],
    [/decision.*needs/i, 'retain decisions needing a human'],
    [/(?:report[\s\S]*then[\s\S]*(?:ask|offer)|after[\s\S]*report[\s\S]*(?:ask|offer))/i, 'offer only after the final report'],
    [/(?:once|one|single)[\s\S]{0,120}(?:offer|question|retrospective)|(?:offer|ask)[\s\S]{0,120}(?:once|one time)/i, 'offer once, not on each walk'],
    [/\/sawmill:sawdust/, 'ask whether to invoke the existing learning workflow'],
    [/(?:exact|same)[\s\S]{0,80}run[\s\S]{0,40}(?:id|identity|scope)/i, 'name the exact run identity'],
    [/retained[\s\S]{0,50}attempt[\s\S]{0,80}logs/i, 'explain the learning evidence'],
    [/friction/i, 'explain that friction is examined'],
    [/safeguards/i, 'explain that helpful safeguards are examined'],
    [/measurabl/i, 'explain that measurable improvements are examined'],
  ]);
});

test('Foreman offers learning for unresolved terminal work but not ongoing or recoverable runs', async () => {
  const body = await skill('foreman');
  const finish = section(body, 'Finish');
  requires(finish, [
    [/completed/i, 'completed runs finish'],
    [/every ticket not done[\s\S]*escalated[\s\S]*stopped[\s\S]*blocked/i, 'unresolved terminal work also finishes'],
    [/(?:unresolved|unfinished|remaining) (?:work|tickets)/i, 'state unresolved work plainly in the offer/report'],
    [/(?:does not|do not|never|must not)[\s\S]{0,100}(?:clear[\s\S]{0,30}logjams|change[\s\S]{0,30}run state)/i, 'retrospectives do not resolve or restart the run'],
  ]);
  requires(body, [
    [/(?:do not|never|no)[\s\S]{0,100}(?:offer|retrospective)[\s\S]{0,150}active/i, 'no offer while active'],
    [/(?:do not|never|no)[\s\S]{0,100}(?:offer|retrospective)[\s\S]{0,150}paused/i, 'no offer while paused'],
    [/(?:do not|never|no)[\s\S]{0,100}(?:offer|retrospective)[\s\S]{0,150}recoverable/i, 'no offer for recoverable work'],
    [/(?:do not|never|no)[\s\S]{0,100}(?:offer|retrospective)[\s\S]{0,150}(?:poll|walk)/i, 'polls do not repeat the offer'],
  ]);
});

test('Foreman acceptance hands off the exact run in the same millyard; decline changes nothing', async () => {
  const finish = section(await skill('foreman'), 'Finish');
  requires(finish, [
    [/(?:accept|yes)[\s\S]{0,200}\/sawmill:sawdust/i, 'acceptance invokes sawdust'],
    [/(?:same|exact)[\s\S]{0,60}millyard/i, 'preserve the millyard'],
    [/(?:same|exact)[\s\S]{0,80}run[\s\S]{0,40}(?:id|identity|scope)/i, 'preserve the run identity in the handoff'],
    [/(?:cannot|can't|unable|does not support)[\s\S]{0,200}(?:invocation|\/sawmill:sawdust)/i, 'provide an exact invocation when the host cannot start a skill'],
    [/(?:declin|\bno\b)[\s\S]{0,200}(?:unchanged|without[\s\S]{0,40}(?:chang|writ)|do not[\s\S]{0,40}(?:chang|writ))/i, 'declining leaves the run and records unchanged'],
  ]);
});

test('sawdust presents user-owned configuration proposals without applying them', async () => {
  const body = await skill('sawdust');
  requires(body, [
    [/project configuration/i, 'classify project configuration ownership'],
    [/(?:user-owned|user owned)[\s\S]{0,120}(?:file|setting)/i, 'identify the user-owned file and setting'],
    [/(?:propos|recommend)[\s\S]{0,160}(?:expected effect|expected impact)/i, 'give the proposed change and expected effect'],
    [/(?:revers|rollback|roll back|undo)/i, 'explain how to reverse the setting'],
    [/baseline/i, 'give a measurement baseline'],
    [/(?:user|person)[\s\S]{0,100}(?:decides|chooses|decision)[\s\S]{0,100}(?:apply|change)/i, 'application is the user decision'],
    [/(?:never|do not|must not)[\s\S]{0,100}(?:edit|change|apply)[\s\S]{0,80}configuration/i, 'learning itself does not edit configuration'],
  ]);
});

test('sawdust routes distributed-source findings to Sawmill upstream with specific issue approval', async () => {
  const body = await skill('sawdust');
  requires(body, [
    [/Sawmill upstream/i, 'classify upstream ownership separately'],
    [/(?:markdlabrecque\/sawmill|Sawmill (?:repository|repo))/i, 'use the Sawmill tracker, not the analyzed project tracker'],
    [/(?:CLI|scheduler)[\s\S]{0,200}(?:skills|templates|defaults|distributed)/i, 'cover distributed code and packaged workflow sources'],
    [/(?:search|check)[\s\S]{0,160}(?:existing|open and closed)[\s\S]{0,160}(?:issue|ticket)/i, 'search before suggesting a duplicate'],
    [/link[\s\S]{0,120}(?:instead|duplicate)/i, 'link existing owning issues'],
    [/(?:file|creat)[\s\S]{0,160}(?:user|invocation)[\s\S]{0,160}(?:asks|request|approv)/i, 'filing requires a user request or approval'],
    [/approv[\s\S]{0,60}specific (?:proposal|recommendation)/i, 'approval is per proposal'],
    [/redact/i, 'use redacted evidence'],
    [/(?:never|do not|must not)[\s\S]{0,160}(?:patch|modif|edit)[\s\S]{0,160}installed/i, 'never patch the installed package during learning'],
    [/(?:local Sawmill|Sawmill checkout)/i, 'protect local Sawmill source too'],
    [/generated files/i, 'protect generated files too'],
    [/(?:separately requested|separate[\s\S]{0,50}(?:ticket|development))/i, 'do not prohibit separately requested ordinary development'],
  ]);
});

test('accepted learning records ownership and measurement without automatically adopting findings', async () => {
  const body = await skill('sawdust');
  const report = section(body, 'Report');
  const ledger = section(body, 'Record accepted learning');
  requires(report, [
    [/(?:owner|ownership|project configuration|upstream)/i, 'recommendations state who owns the action'],
  ]);
  requires(ledger, [
    [/\.mill\/learning\.md/, 'use the existing learning ledger'],
    [/only after the user accepts/i, 'record only accepted recommendations'],
    [/(?:decision|accepted action)/i, 'record the decision'],
    [/(?:owner|ownership|project configuration|upstream)/i, 'record action ownership'],
    [/(?:ticket|issue)/i, 'record a follow-up issue when applicable'],
    [/baseline/i, 'record the measurement baseline'],
    [/later[\s\S]*measure/i, 'measure accepted learning on a later retrospective'],
    [/(?:does not|do not|never|not)[\s\S]{0,100}(?:apply|adopt|implement)/i, 'recording a recommendation does not apply it'],
  ]);
  requires(body, [
    [/(?:Jev|screening)[\s\S]{0,300}(?:cannot|never|does not|do not)[\s\S]{0,150}(?:authorize|action|change|edit)/i, 'screening findings confer no action authority'],
  ]);
});

test('nightwatch decides instead of asking, within its destructive and loop limits', async () => {
  const body = await skill('nightwatch');
  requires(body, [
    [/[Nn]ever ask the user anything/, 'never ask'],
    [/[Nn]ever\*\* run `mill run close`/, 'never close'],
    [/`mill run reset` at most \*\*once per ticket\*\*/, 'reset at most once per ticket'],
    [/at most \*\*two\*\* plays per logjam reason[\s\S]{0,300}\*\*park\*\*/, 'two plays, then park'],
    [/\/sawmill:mill-report/, 'report at finish'],
  ]);
});
