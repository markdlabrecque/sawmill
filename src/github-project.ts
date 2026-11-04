import { execFile } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMap, isScalar, parseDocument } from 'yaml';
import { loadConfig, type ProjectConfig } from './config.js';
import { githubAccount } from './github-account.js';
import { githubRequest } from './github-transport.js';
import { withGitHubProjectLock } from './github-project-lock.js';

export const humanEstimateField = 'Human estimate (hours)';
interface EstimateProject { id: string; number: number; title: string; url: string; public: boolean }
interface Field { id: string; name: string; dataType: string }
interface Page<T> { nodes: T[]; totalCount?: number; pageInfo?: { hasNextPage: boolean; endCursor: string } }

/** All gh calls, including project subcommands, use the millyard-selected account. */
async function gh(cwd: string, args: string[]): Promise<unknown> {
  const account = await githubAccount(cwd);
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, env: account.env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { reject(new Error(account.redact(stderr.trim() || error.message))); return; }
      try { resolve(stdout.trim() ? JSON.parse(account.redact(stdout)) : null); }
      catch { reject(new Error('GitHub returned invalid JSON.')); }
    });
  });
}

async function graphql<T>(cwd: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const result = await githubRequest({ backend: 'github', repo: '' }, cwd, 'POST', 'graphql', { query, variables }) as { data?: T; errors?: { message: string }[] };
  if (result?.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
  if (!result?.data) throw new Error('GitHub returned no GraphQL data.');
  return result.data;
}

const projectFields = 'id number title url public';
async function lookup(cwd: string, project: ProjectConfig): Promise<EstimateProject[]> {
  const [owner, name] = project.tracker.repo.split('/');
  const number = project.tracker.project;
  const selection = number === undefined
    ? `projectsV2(first:100, after:$cursor) { nodes { ${projectFields} } totalCount pageInfo { hasNextPage endCursor } }`
    : `projectV2(number:$number) { ${projectFields} }`;
  const query = `query($owner:String!, $name:String!, ${number === undefined ? '$cursor:String' : '$number:Int!'}) {
    repository(owner:$owner,name:$name) { owner { login ... on User { ${selection} } ... on Organization { ${selection} } } }
  }`;
  const matches: EstimateProject[] = [];
  let cursor: string | undefined;
  do {
    const data = await graphql<{ repository: { owner: { projectV2?: EstimateProject | null; projectsV2?: Page<EstimateProject> } } | null }>(cwd, query, { owner, name, ...(number === undefined ? { cursor: cursor ?? null } : { number }) });
    if (!data.repository?.owner) throw new Error(`Cannot read GitHub repository ${project.tracker.repo}.`);
    if (number !== undefined) return data.repository.owner.projectV2 ? [data.repository.owner.projectV2] : [];
    const page = data.repository.owner.projectsV2;
    if (!page || !Array.isArray(page.nodes)) throw new Error('Cannot read the owner\'s GitHub Projects.');
    matches.push(...page.nodes.filter(item => item.title === project.name));
    cursor = nextCursor(page);
  } while (cursor);
  return matches;
}

function nextCursor(page: Page<unknown>): string | undefined {
  if (!page.pageInfo?.hasNextPage) {
    if (!page.pageInfo && (page.totalCount === undefined || page.totalCount > page.nodes.length)) throw new Error('GitHub returned an incomplete Project collection.');
    return undefined;
  }
  if (!page.pageInfo.endCursor) throw new Error('GitHub omitted a pagination cursor.');
  return page.pageInfo.endCursor;
}

async function fields(cwd: string, project: EstimateProject): Promise<Field[]> {
  const result: Field[] = [];
  let cursor: string | undefined;
  do {
    const data = await graphql<{ node: { fields: Page<Field> } | null }>(cwd, `query($id:ID!, $cursor:String) {
      node(id:$id) { ... on ProjectV2 { fields(first:100, after:$cursor) {
        nodes { ... on ProjectV2Field { id name dataType } } pageInfo { hasNextPage endCursor }
      } } }
    }`, { id: project.id, cursor: cursor ?? null });
    if (!data.node?.fields) throw new Error(`Cannot read fields of ${project.url}.`);
    result.push(...data.node.fields.nodes);
    cursor = nextCursor(data.node.fields);
  } while (cursor);
  const named = result.find(field => field.name === humanEstimateField);
  if (named && named.dataType !== 'NUMBER') throw new Error(`${project.url} has ${humanEstimateField}, but it is not a number field. Correct the field type and retry.`);
  return result;
}

/** GitHub's addProjectV2ItemById is an upsert by contentId, not a title/number
 * check-then-add. The server returns the existing item when content is present.
 * Repeat the mutation and verify its identity to check the duplicate contract on
 * the actual host, also when auto-add or another command wins the first add. */
export async function addGitHubProjectTicket(cwd: string, projectId: string, contentId: string): Promise<string> {
  const query = `mutation($project:ID!, $content:ID!) {
    addProjectV2ItemById(input:{projectId:$project,contentId:$content}) {
      item { id content { ... on Issue { id } } }
    }
  }`;
  const add = async () => {
    const data = await graphql<{ addProjectV2ItemById: { item: { id: string; content: { id: string } } } }>(cwd, query, { project: projectId, content: contentId });
    const item = data.addProjectV2ItemById?.item;
    if (!item?.id || item.content?.id !== contentId) throw new Error('GitHub did not confirm the Project item\'s stable ticket identity.');
    return item.id;
  };
  const first = await add();
  if (await add() !== first) throw new Error('GitHub did not reuse the existing Project item; duplicate protection could not be verified.');
  return first;
}

/** Change only the numeric scalar (or insert one mapping entry), preserving the
 * original bytes of all other keys and comments, including flow-style YAML. */
async function saveNumber(cwd: string, number: number): Promise<void> {
  const path = join(cwd, '.mill/config.yaml');
  const text = await readFile(path, 'utf8');
  const doc = parseDocument(text);
  const tracker = doc.get('tracker', true);
  if (doc.errors.length || !isMap(tracker) || !tracker.range) throw new Error(`Cannot update tracker.project in ${path}.`);
  const prior = tracker.get('project', true);
  let saved: string;
  if (isScalar(prior) && prior.range) saved = text.slice(0, prior.range[0]) + number + text.slice(prior.range[1]);
  else if (tracker.flow) {
    const end = tracker.range[1] - 1;
    saved = text.slice(0, end) + `${tracker.items.length ? ', ' : ''}project: ${number}` + text.slice(end);
  } else {
    const key = tracker.items[0]?.key;
    if (!isScalar(key) || !key.range) throw new Error('Cannot locate the tracker mapping.');
    const indent = key.range[0] - text.lastIndexOf('\n', key.range[0]) - 1;
    const end = tracker.range[1];
    saved = text.slice(0, end) + `${text[end - 1] === '\n' ? '' : '\n'}${' '.repeat(indent)}project: ${number}\n` + text.slice(end);
  }
  const temporary = `${path}.project-${process.pid}.tmp`;
  await writeFile(temporary, saved);
  await rename(temporary, path);
}

async function linked(cwd: string, project: EstimateProject, repo: string): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const data = await graphql<{ node: { repositories: Page<{ nameWithOwner: string }> } | null }>(cwd, `query($id:ID!, $cursor:String) {
      node(id:$id) { ... on ProjectV2 { repositories(first:100, after:$cursor) {
        nodes { nameWithOwner } pageInfo { hasNextPage endCursor }
      } } }
    }`, { id: project.id, cursor: cursor ?? null });
    if (!data.node?.repositories) throw new Error(`Cannot verify repository link for ${project.url}.`);
    if (data.node.repositories.nodes.some(repository => repository.nameWithOwner.toLowerCase() === repo.toLowerCase())) return true;
    cursor = nextCursor(data.node.repositories);
  } while (cursor);
  return false;
}

/** Logging's only Project-item write path; uses the same upsert as backfill. */
export async function addConfiguredGitHubProjectTicket(cwd: string, config: ProjectConfig, number: number): Promise<{ item: string; project: string }> {
  if (config.tracker.backend !== 'github' || (config.tracker.host ?? 'github.com') !== 'github.com' || config.tracker.project === undefined) throw new Error('A github.com tracker.project is required; run Mill interactively to set up the GitHub estimate project first.');
  const project = (await lookup(cwd, config))[0];
  if (!project) throw new Error('The configured GitHub estimate project is missing; run Mill interactively to repair it.');
  const ticket = await githubRequest(config.tracker, cwd, 'GET', `repos/${config.tracker.repo}/issues/${number}`) as { node_id?: string; pull_request?: unknown };
  if (!ticket?.node_id || ticket.pull_request) throw new Error('GitHub did not return a stable ticket identity (pull requests are not tickets).');
  return { item: await addGitHubProjectTicket(cwd, project.id, ticket.node_id), project: project.url };
}

// A saved number and field do not prove that ticket backfill finished. Keep a
// local recovery marker until every setup step and the config write succeeds.
const pendingSetup = (cwd: string) => join(cwd, '.mill/github-project-setup.json');
async function hasPendingSetup(cwd: string, config: ProjectConfig, project: EstimateProject): Promise<boolean> {
  try {
    const pending = JSON.parse(await readFile(pendingSetup(cwd), 'utf8'));
    return pending.repo === config.tracker.repo && pending.id === project.id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function complete(cwd: string, config: ProjectConfig, existing: EstimateProject | undefined, report: (text: string) => void): Promise<void> {
  const owner = config.tracker.repo.split('/')[0]!;
  let project = existing;
  let step = 'create the GitHub estimate project';
  try {
    if (!project) {
      project = await gh(cwd, ['project', 'create', '--owner', owner, '--title', config.name, '--format', 'json']) as EstimateProject;
      if (!project?.id || !Number.isSafeInteger(project.number) || !project.url) throw new Error('GitHub did not return the created Project identity; retry to look it up by title.');
      report(`Created GitHub estimate project: ${project.url}`);
    }
    step = 'record incomplete setup for recovery';
    await writeFile(pendingSetup(cwd), JSON.stringify({ repo: config.tracker.repo, id: project.id }));
    const number = String(project.number);
    // Recovered title matches are incomplete creations until all steps read back.
    if (config.tracker.project !== project.number || !existing) {
      step = 'set private visibility';
      await gh(cwd, ['project', 'edit', number, '--owner', owner, '--visibility', 'PRIVATE']);
    }
    step = 'link the repository';
    await gh(cwd, ['project', 'link', number, '--owner', owner, '--repo', config.tracker.repo]);
    step = 'read or create the Human estimate (hours) number field';
    if (!(await fields(cwd, project)).some(field => field.name === humanEstimateField)) {
      await gh(cwd, ['project', 'field-create', number, '--owner', owner, '--name', humanEstimateField, '--data-type', 'NUMBER', '--format', 'json']);
    }
    step = 'add existing open tickets';
    const pages = await githubRequest(config.tracker, cwd, 'GET', `repos/${config.tracker.repo}/issues?state=open&per_page=100`, undefined, { paginated: true });
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('GitHub returned an incomplete open ticket collection.');
    for (const ticket of pages.flat() as { pull_request?: unknown; node_id?: string }[]) {
      if (ticket.pull_request) continue;
      if (!ticket.node_id) throw new Error('GitHub omitted a ticket\'s stable identity.');
      await addGitHubProjectTicket(cwd, project.id, ticket.node_id);
    }
    // GitHub's public schema exposes no Projects workflow/auto-add write API.
    // Verify against the actual schema instead of treating an auth error as absence.
    step = 'verify auto-add API availability';
    const schema = await graphql<{ __type: { fields: { name: string }[] } }>(cwd, '{ __type(name:"Mutation") { fields { name } } }', {});
    if (!schema.__type?.fields) throw new Error('Cannot verify GitHub auto-add API availability.');
    const workflow = schema.__type.fields.filter(field => /project.*(workflow|autoadd)|(workflow|autoadd).*project/i.test(field.name));
    if (workflow.length) throw new Error(`GitHub now exposes Project workflow mutations (${workflow.map(field => field.name).join(', ')}); review auto-add support before completing setup.`);
    report(`One-time manual step: in ${project.url}, open Workflows → Auto-add to project, select ${config.tracker.repo} with is:issue is:open, and enable it. The public GitHub API has no auto-add configuration mutation; duplicate protection works without it.`);
    step = 'read back the GitHub estimate project, field and repository link';
    const readback = (await lookup(cwd, { ...config, tracker: { ...config.tracker, project: project.number } }))[0];
    if (!readback || !(await fields(cwd, readback)).some(field => field.name === humanEstimateField)) throw new Error('GitHub Project/estimate-field readback failed.');
    if (readback.id !== project.id || readback.number !== project.number) throw new Error('GitHub Project identity changed during readback.');
    if ((config.tracker.project !== project.number || !existing) && (readback.public || readback.title !== config.name)) throw new Error('GitHub Project title or private visibility readback failed.');
    if (!await linked(cwd, readback, config.tracker.repo)) throw new Error('GitHub Project repository-link readback failed.');
    step = 'save tracker.project in .mill/config.yaml';
    await saveNumber(cwd, project.number);
    step = 'clear the completed setup recovery marker';
    await unlink(pendingSetup(cwd));
    report(`GitHub estimate project ready: ${project.url}; saved tracker.project: ${project.number}.`);
  } catch (error) {
    throw new Error(`${project?.url ? `GitHub estimate project exists: ${project.url}. ` : ''}Failed to ${step}: ${error instanceof Error ? error.message : error} Setup incomplete; fix the failed step and retry the same Mill command to recover it without creating another Project.`);
  }
}

export async function offerGitHubProject(cwd: string, home: string, config: ProjectConfig, options: {
  ask?: (question: string) => Promise<string>; report: (text: string) => void;
}): Promise<void> {
  if (config.tracker.backend !== 'github' || (config.tracker.host ?? 'github.com') !== 'github.com') return;
  const report = options.report;
  const manual = () => report(`GitHub estimate project setup skipped. In an interactive terminal run this Mill command again, or use gh project create --owner ${config.tracker.repo.split('/')[0]} --title ${config.name} --format json, keep it private, link ${config.tracker.repo}, add the number field "${humanEstimateField}" and open tickets, then set tracker.project to its number in .mill/config.yaml.`);
  // Non-interactive commands remain usable offline. They cannot consent to any
  // repair, so explain setup without contacting GitHub or opening a local lock.
  if (!options.ask) { if (config.tracker.project === undefined) manual(); return; }
  const inspect = async (project: ProjectConfig) => {
    let matches = await lookup(cwd, project);
    // A stale configured number can coexist with a partially created replacement
    // whose number was not saved. Recover by title before offering a new one.
    if (!matches.length && project.tracker.project !== undefined) matches = await lookup(cwd, { ...project, tracker: { ...project.tracker, project: undefined } });
    if (matches.length > 1) {
      report(`Several GitHub estimate projects match ${project.name}: ${matches.map(item => `${item.number}: ${item.url}`).join(', ')}. Set tracker.project explicitly; nothing was offered.`);
      return { ready: true };
    }
    const existing = matches[0];
    const hasField = existing && (await fields(cwd, existing)).some(field => field.name === humanEstimateField);
    const pending = existing && await hasPendingSetup(cwd, project, existing);
    return { ready: Boolean(existing && project.tracker.project === existing.number && hasField && !pending), existing, hasField };
  };
  try {
    const state = await inspect(config);
    if (state.ready) return;
    const owner = config.tracker.repo.split('/')[0]!;
    const proposal = state.existing
      ? `Reuse GitHub estimate project ${state.existing.url}${state.hasField ? '' : ` and add the number field ${humanEstimateField}`}; link ${config.tracker.repo}, add existing open tickets once, and record tracker.project? [y/N] `
      : `Create a private GitHub estimate project under ${owner}, titled ${config.name}, linked to ${config.tracker.repo}, with the number field ${humanEstimateField}, add all existing open tickets once, and record tracker.project in .mill/config.yaml? [y/N] `;
    if (!options.ask || !/^y(es)?$/i.test((await options.ask(proposal)).trim())) {
      manual();
      return;
    }
    await withGitHubProjectLock(cwd, async () => {
      // A title check before locking cannot exclude concurrent local creation.
      const current = await loadConfig(cwd, home);
      if (!current.valid) throw new Error('Configuration changed during setup; correct it and retry.');
      if (current.project.name !== config.name || current.project.tracker.repo !== config.tracker.repo || current.project.tracker.backend !== 'github' || (current.project.tracker.host ?? 'github.com') !== 'github.com') throw new Error('Tracker identity changed during setup; retry and review the new proposal.');
      const fresh = await inspect(current.project);
      if (!fresh.ready) await complete(cwd, current.project, fresh.existing, report);
    });
  } catch (error) {
    report(`GitHub estimate project setup: ${error instanceof Error ? error.message : error} Check network access and the selected gh account (gh auth login; gh auth refresh -s project), then retry. Failed lookups never authorize creation.`);
  }
}
