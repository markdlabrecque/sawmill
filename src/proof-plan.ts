/** How a ticket proves its change: new failing tests first, or the project's existing checks. */
export type ProofPath = 'test-first' | 'existing-checks';
export interface ProofPlan { path: ProofPath; reason: string }

const paths: ProofPath[] = ['test-first', 'existing-checks'];

/** The conservative plan for a ticket that declares none. */
export const defaultProofPlan: ProofPlan = { path: 'test-first', reason: 'No proof plan declared; new behaviour needs a failing test first.' };

/** Reads the ticket's `## Proof plan` section (`Path:` and `Reason:` lines), outside code fences.
 * No section is the default plan; a section with an unknown path or no reason is refused. */
export function proofPlan(body: string): ProofPlan {
  let inSection = false, present = false;
  let fence: string | undefined;
  let path: string | undefined, reason: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (delimiter) { if (!fence) fence = delimiter; else if (delimiter.startsWith(fence)) fence = undefined; continue; }
    if (fence) continue;
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (heading[1]!.length <= 2) inSection = heading[1]!.length === 2 && /^Proof plan$/i.test(heading[2]!);
      present ||= inSection;
      continue;
    }
    if (!inSection) continue;
    const field = line.match(/^\s*(?:\*\*)?(Path|Reason)\s*:(?:\*\*)?\s*(.*?)\s*$/i);
    if (field?.[1]!.toLowerCase() === 'path') path ??= field[2]!.replace(/^`(.*)`$/, '$1');
    else if (field) reason ??= field[2];
  }
  if (!present) return defaultProofPlan;
  if (!paths.includes(path as ProofPath)) throw new Error(`Proof plan path must be one of ${paths.join(', ')}; got ${path ? JSON.stringify(path) : 'none'}.`);
  if (!reason) throw new Error('Proof plan needs a Reason: line explaining why this path is sufficient.');
  return { path: path as ProofPath, reason };
}
