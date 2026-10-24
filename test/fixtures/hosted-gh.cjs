// Scripted GitHub Actions boundary for CI repair tests. No network; scenario comes from HOSTED_SCENARIO.
// Scenario: { checks, status, runs: {id: run}, jobs: {id: job}, logs: {jobId: text | {repeat, times}}, logFail: [jobId] }
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const url = new URL('https://fixture.invalid/' + args[1]);
fs.appendFileSync(process.env.HOSTED_LOG, JSON.stringify({ endpoint: args[1] }) + '\n');
const head = cp.execFileSync('git', ['rev-parse', 'mill/12'], { cwd: process.env.HOSTED_CWD, encoding: 'utf8' }).trim();
const data = JSON.parse(fs.readFileSync(process.env.HOSTED_SCENARIO, 'utf8').replaceAll('HEAD_SHA', head));
const fail = (status, message) => { process.stderr.write(`gh: ${message} (HTTP ${status})\n`); process.exit(1); };
const page = Number(url.searchParams.get('page') || '1');
const rest = url.pathname.replace(/^\/repos\/team\/tool\//, '');
if (rest === url.pathname) fail(404, 'Not Found');
const out = value => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const pick = (table, key) => table?.[key] ?? fail(404, 'Not Found');
let m;
if (/^commits\/[^/]+\/check-runs$/.test(rest)) out(Array.isArray(data.checks) ? data.checks[page - 1] : data.checks);
if (/^commits\/[^/]+\/status$/.test(rest)) out(Array.isArray(data.status) ? data.status[page - 1] : data.status);
if ((m = rest.match(/^actions\/jobs\/(\d+)\/logs$/))) {
  if ((data.logFail || []).includes(Number(m[1]))) fail(500, 'Server Error');
  const log = pick(data.logs, m[1]);
  // Exit only after the write completes, and stop the script here so nothing below runs meanwhile.
  process.stdout.write(typeof log === 'string' ? log : log.repeat.repeat(log.times), () => process.exit(0));
  return;
}
if ((m = rest.match(/^actions\/jobs\/(\d+)$/))) out(pick(data.jobs, m[1]));
if ((m = rest.match(/^actions\/runs\/(\d+)$/))) out(pick(data.runs, m[1]));
if ((m = rest.match(/^actions\/runs\/(\d+)\/attempts\/(\d+)$/))) out({ ...pick(data.runs, m[1]), run_attempt: Number(m[2]) });
if ((m = rest.match(/^actions\/runs\/(\d+)\/(?:attempts\/(\d+)\/)?jobs$/))) {
  const run = pick(data.runs, m[1]);
  const attempt = m[2] ? Number(m[2]) : url.searchParams.get('filter') === 'all' ? undefined : run.run_attempt;
  const jobs = Object.values(data.jobs).filter(job => job.run_id === Number(m[1]) && (attempt === undefined || job.run_attempt === attempt));
  const pages = [];
  for (let i = 0; i < Math.max(1, jobs.length); i += 100) pages.push({ total_count: jobs.length, jobs: jobs.slice(i, i + 100) });
  out(args.includes('--slurp') ? pages : pages[page - 1] || { total_count: jobs.length, jobs: [] });
}
if (/\/pulls|\/issues\//.test(rest)) out({});
fail(404, 'Unscripted request: ' + rest);
