// Scripted hosting boundary. All git operations are confined to the test's local remote.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
const body = input ? JSON.parse(input) : undefined;
const method = args[args.indexOf('--method') + 1];
const endpoint = args[1];
const statePath = process.env.FAKE_GITLAB_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const url = new URL('https://fixture.invalid/' + endpoint);
const prefix = url.pathname.startsWith('/projects/71/') ? '/projects/71' : '/projects/group%2Fsubgroup%2Ftool';
const route = url.pathname.slice(prefix.length);
const fail = (status, message) => { process.stderr.write(`glab: ${message} (HTTP ${status})\n`); process.exit(1); };
if (args[0] !== 'api' || !url.pathname.startsWith(prefix) || args[args.indexOf('--hostname') + 1] !== state.host) fail(400, 'Wrong project or hostname');
fs.appendFileSync(process.env.FAKE_GITLAB_LOG, JSON.stringify({ method, endpoint, body }) + '\n');
function reply(value, next) {
  let pagination = next === undefined ? '' : `X-Next-Page: ${next}\r\n`;
  if (state.linkPagination && next !== undefined) {
    const link = new URL('https://' + state.host + '/api/v4/' + endpoint); link.searchParams.set('page', next);
    pagination = next ? `Link: <${link}>; rel="next"\r\n` : '';
  }
  if (state.truncatedPipeline && /\/pipelines\/\d+\/(trigger_jobs|bridges)$/.test(route)) pagination = 'X-Next-Page: \r\nX-Total: 2\r\n';
  if (args.includes('--include')) process.stdout.write(value === undefined ? 'HTTP/2.0 204 No Content\r\n\r\n' : `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${pagination}\r\n`);
  process.stdout.write(value === undefined ? '' : JSON.stringify(value));
  process.exit(0);
}
function list(rows) {
  const page = Number(url.searchParams.get('page') || '1');
  const size = state.pageSize || 100;
  const end = page * size;
  reply(rows.slice(end - size, end), end < rows.length ? String(page + 1) : '');
}
const git = (...argv) => execFileSync('git', argv, { cwd: state.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const head = () => git('ls-remote', 'origin', 'refs/heads/mill/7').split(/\s/)[0];
const pip = row => ({ project_id: 71, ...row, sha: row.sha === 'HEAD_SHA' ? head() : row.sha });
function currentPipeline() {
  const relevant = (state.pipelines || []).filter(p => p.ref === 'mill/7' && p.source !== 'parent_pipeline');
  const mrs = relevant.filter(p => p.source === 'merge_request_event');
  const rows = mrs.length ? mrs : relevant;
  return rows.sort((a, b) => b.id - a.id)[0];
}
function mr() {
  return { iid: 42, project_id: 71, source_project_id: 71, target_project_id: 71, source_branch: 'mill/7', target_branch: 'integration',
    head_pipeline: currentPipeline() ? pip(currentPipeline()) : null, web_url: `https://${state.host}/group/subgroup/tool/-/merge_requests/42`, state: 'opened', sha: head(), ...state.mr, ...state.mrOverride };
}
if (route === '/merge_requests' && method === 'GET') {
  if (url.searchParams.get('source_branch') !== 'mill/7' || url.searchParams.get('target_branch') !== 'integration' || url.searchParams.get('state') !== 'opened') fail(400, 'Wrong MR filters');
  list([...(state.otherMrs || []), ...(state.mr ? [mr()] : [])]);
}
if (route === '/merge_requests' && method === 'POST') {
  if (state.mr) fail(409, 'Duplicate MR');
  if (body.source_branch !== 'mill/7' || body.target_branch !== 'integration') fail(400, 'Wrong MR branches');
  state.mr = { title: body.title, description: body.description };
  state.openCount = (state.openCount || 0) + 1;
  fs.writeFileSync(statePath, JSON.stringify(state)); reply(mr());
}
if (route === '/merge_requests/42' && method === 'GET') reply({ ...mr(), ...(state.finalMrHead ? { sha: state.finalMrHead } : {}) });
const pipelineRoute = route.match(/^\/pipelines\/(\d+)(?:\/(trigger_jobs|bridges))?$/);
if (pipelineRoute && method === 'GET') {
  if (pipelineRoute[2]) list((state.triggers?.[pipelineRoute[1]] || []).map(j => ({ ...j, downstream_pipeline: j.downstream_pipeline ? pip(j.downstream_pipeline) : null })));
  const p = (state.pipelines || []).find(p => p.id === Number(pipelineRoute[1]));
  if (!p) fail(404, 'Pipeline not found');
  reply(pip(p));
}
if (route === '/pipelines' && method === 'GET') {
  if (url.searchParams.get('sha') !== head()) fail(400, 'Pipeline must request the exact pushed SHA');
  list((state.pipelines || []).filter(row => url.searchParams.get('source') === 'parent_pipeline' ? row.source === 'parent_pipeline' : row.source !== 'parent_pipeline')
    .map(row => ({ ...row, sha: row.sha === 'HEAD_SHA' ? head() : row.sha })));
}
if (route === '/merge_requests/42/merge' && method === 'PUT') {
  if (body.sha !== head()) fail(409, 'SHA does not match HEAD of source branch');
  if (state.mergeRefusal) {
    if (state.pipelineOnRefusal) { state.pipelines = state.pipelineOnRefusal; fs.writeFileSync(statePath, JSON.stringify(state)); }
    fail(state.mergeRefusal, 'Fixture merge refusal');
  }
  const host = state.cwd + '/../hosting';
  git('clone', '--branch', 'integration', state.remote, host);
  git('-C', host, 'config', 'user.name', 'Fixture Hosting'); git('-C', host, 'config', 'user.email', 'fixture@example.invalid');
  git('-C', host, 'config', 'core.hooksPath', '/dev/null');
  git('-C', host, 'merge', body.squash ? '--squash' : '--no-ff', 'origin/mill/7', ...(body.squash ? [] : ['-m', 'Fixture merge']));
  if (body.squash) git('-C', host, 'commit', '-m', 'Fixture squash');
  const mergeCommit = git('-C', host, 'rev-parse', 'HEAD');
  git('-C', host, 'push', 'origin', 'HEAD:refs/heads/integration');
  state.mergeCount = (state.mergeCount || 0) + 1;
  state.mr = { ...state.mr, state: 'merged', merge_commit_sha: mergeCommit };
  fs.writeFileSync(statePath, JSON.stringify(state)); reply(mr());
}
if (route === '/repository/branches/mill%2F7' && method === 'DELETE') {
  if (state.deleteFailure) fail(503, 'Branch delete unavailable');
  git('push', '--no-follow-tags', 'origin', '--delete', 'mill/7'); reply();
}
const issueMatch = route.match(/^\/issues\/(\d+)(\/notes)?$/);
if (issueMatch && method !== 'GET') {
  if (state.failWrites) fail(503, 'Mirror temporarily unavailable');
  if (state.closeFailure && body?.state_event === 'close') fail(503, 'Close temporarily unavailable');
  const issue = state.issues.find(issue => issue.iid === Number(issueMatch[1]));
  if (!issue) fail(404, 'Issue not found');
  if (method === 'POST' && issueMatch[2]) {
    (state.notes[issue.iid] ||= []).push({ id: 100 + (state.notes[issue.iid] || []).length, body: body.body, author: { username: 'mill' }, created_at: '2026-10-22T01:00:00Z' });
  } else if (method === 'PUT' && !issueMatch[2]) {
    if (body.add_labels) {
      issue.labels = [...new Set([...issue.labels, ...body.add_labels.split(',')])];
      state.availableLabels = [...new Set([...state.availableLabels, ...body.add_labels.split(',')])];
    }
    if (body.remove_labels) issue.labels = issue.labels.filter(label => !body.remove_labels.split(',').includes(label));
    if (body.state_event === 'close') issue.state = 'closed';
  } else fail(400, 'Wrong issue mutation');
  fs.writeFileSync(statePath, JSON.stringify(state));
  reply(issue);
}
if (route === '/issues' && method === 'GET') {
  if (state.forbidIssueReads) fail(500, 'Issue read after draft');
  if (url.searchParams.get('state') !== 'all' || url.searchParams.get('scope') !== 'all') fail(400, 'Listing must include closed and unassigned issues');
  if (url.searchParams.get('order_by') !== 'created_at') fail(400, 'Unsupported issue order_by; use the documented created_at order');
  const label = url.searchParams.get('labels');
  list(state.issues.filter(issue => !label || issue.labels.includes(label)));
}
if (route === '/labels' && method === 'GET') list(state.availableLabels.map(name => ({ name })));
if (issueMatch && method === 'GET') {
  if (state.forbidIssueReads) fail(500, 'Issue read after draft');
  const issue = state.issues.find(issue => issue.iid === Number(issueMatch[1]));
  if (!issue) fail(404, 'Issue not found');
  if (issueMatch[2]) list(state.notes[issue.iid] || []);
  reply(issue);
}
fail(500, 'Unscripted request: ' + method + ' ' + route);
