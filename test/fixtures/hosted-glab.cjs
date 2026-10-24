// Scripted GitLab CI boundary for CI repair tests. No network; scenario comes from HOSTED_SCENARIO.
// Scenario: { polls: [{ pipelines: {id: {status, project_id}}, triggers: {id: [trigger job]}, jobs: {id: [job]} }],
//             traces: {jobId: text | {repeat, times}}, traceFail: [jobId] }
// Each merge request read is one poll; the last poll repeats.
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const url = new URL('https://fixture.invalid/' + args[1]);
fs.appendFileSync(process.env.HOSTED_LOG, JSON.stringify({ method, endpoint: args[1] }) + '\n');
const head = cp.execFileSync('git', ['rev-parse', 'mill/12'], { cwd: process.env.HOSTED_CWD, encoding: 'utf8' }).trim();
const data = JSON.parse(fs.readFileSync(process.env.HOSTED_SCENARIO, 'utf8').replaceAll('HEAD_SHA', head));
// A reply exits only after its output is flushed, so later fall-through code must not fail or exit first.
let replied = false;
const fail = (status, message) => { if (replied) return; process.stderr.write(`glab: ${message} (HTTP ${status})\n`); process.exit(1); };
const route = url.pathname.match(/^\/projects\/([^/]+)(\/.*)$/);
if (!route) fail(404, 'Not Found');
const project = decodeURIComponent(route[1]), rest = route[2];
const counter = process.env.HOSTED_SCENARIO + '.polls';
const polls = () => Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : '0');
const poll = () => data.polls[Math.min(polls(), data.polls.length) - 1];
const reply = (body, headers = '', type = 'application/json') => {
  replied = true;
  process.stdout.write(`HTTP/2.0 200 OK\r\nContent-Type: ${type}\r\n${headers}\r\n`);
  process.stdout.write(typeof body === 'string' ? body : JSON.stringify(body), () => process.exit(0));
};
const list = rows => {
  const page = Number(url.searchParams.get('page') || '1');
  const end = page * 100;
  reply(rows.slice(end - 100, end), `X-Total: ${rows.length}\r\nX-Next-Page: ${end < rows.length ? page + 1 : ''}\r\n`);
};
const pipelineUrl = (id, row) => `https://gitlab.com/${row.project_id === 71 ? 'team/tool' : 'team/downstream'}/-/pipelines/${id}`;
const pipeline = id => {
  const row = poll().pipelines[id] || fail(404, 'Pipeline not found');
  if (String(row.project_id) !== project && !(project === 'team/tool' && row.project_id === 71)) fail(404, 'Pipeline not found');
  return { id: Number(id), project_id: row.project_id, sha: head, status: row.status, web_url: pipelineUrl(id, row) };
};
let m;
if (rest === '/merge_requests/1') {
  fs.writeFileSync(counter, String(polls() + 1));
  reply({ iid: 1, project_id: 71, source_project_id: 71, target_project_id: 71, source_branch: 'mill/12', target_branch: 'integration', state: 'opened', sha: head,
    web_url: 'https://gitlab.com/team/tool/-/merge_requests/1', head_pipeline: pipeline(100) });
}
if ((m = rest.match(/^\/pipelines\/(\d+)$/))) reply(pipeline(m[1]));
if ((m = rest.match(/^\/pipelines\/(\d+)\/(?:trigger_jobs|bridges)$/))) {
  pipeline(m[1]);
  list((poll().triggers?.[m[1]] || []).map(job => ({ ...job, downstream_pipeline: job.downstream_pipeline ? { sha: head, ...job.downstream_pipeline, web_url: pipelineUrl(job.downstream_pipeline.id, job.downstream_pipeline) } : null })));
}
if ((m = rest.match(/^\/pipelines\/(\d+)\/jobs$/))) {
  pipeline(m[1]);
  let jobs = (poll().jobs?.[m[1]] || []).map(job => ({ ...job, pipeline: { id: Number(m[1]), project_id: pipeline(m[1]).project_id, sha: head } }));
  // GitLab hides retried attempts unless asked; the newest job of a name is the current attempt.
  if (url.searchParams.get('include_retried') !== 'true') jobs = jobs.filter(job => !jobs.some(other => other.name === job.name && other.id > job.id));
  const scope = url.searchParams.getAll('scope[]').concat(url.searchParams.getAll('scope'));
  if (scope.length) jobs = jobs.filter(job => scope.includes(job.status));
  list(jobs);
}
if ((m = rest.match(/^\/jobs\/(\d+)\/trace$/))) {
  if ((data.traceFail || []).includes(Number(m[1]))) fail(500, 'Server Error');
  const trace = data.traces?.[m[1]] ?? fail(404, 'Not Found');
  reply(typeof trace === 'string' ? trace : trace.repeat.repeat(trace.times), '', 'text/plain');
}
if ((m = rest.match(/^\/jobs\/(\d+)$/))) {
  const found = Object.entries(poll().jobs || {}).flatMap(([id, jobs]) => jobs.map(job => ({ ...job, pipeline: { id: Number(id), project_id: pipeline(id).project_id, sha: head } }))).find(job => job.id === Number(m[1]));
  reply(found || fail(404, 'Not Found'));
}
fail(404, 'Unscripted request: ' + rest);
