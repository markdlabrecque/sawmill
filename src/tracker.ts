export interface TicketComment {
  body: string;
  author?: string;
  createdAt?: string;
}

/** A comment as the tracker identifies it, so it can be deleted. */
export interface IssueComment {
  id: number | string;
  body: string;
}

export interface Ticket {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  comments: TicketComment[];
  /** null means native dependencies are unavailable; [] means supported, no blockers. */
  blockedBy: number[] | null;
}

export interface TicketReader {
  getTicket(number: number): Promise<Ticket>;
  /** Return all matching tickets, including closed tickets, with complete threads; draft skips the closed ones. */
  listByLabel?(label: string): Promise<Ticket[]>;
  /** Return all direct children, with complete threads; do not include the parent. */
  listChildren?(number: number): Promise<Ticket[]>;
}

export interface ChangeRequest {
  id: number | string;
  url: string;
  headCommit: string;
}

/** A pipeline observation belongs to one exact commit, never an implicit latest head. */
export interface Pipeline {
  headCommit: string;
  state: 'pending' | 'passed' | 'failed' | 'none';
  logUrl?: string;
  diagnostics?: string;
  /** Failed jobs, listed only for a failed pipeline. */
  jobs?: CiJob[];
}

/** One failed CI job. A log id is set only once the job is verified to belong to the tested commit and current attempt. */
export interface CiJob {
  name: string;
  url?: string;
  /** The workflow run and attempt, or the GitLab pipeline and project, the job ran in. */
  source: string;
  logId?: string;
  /** GitLab's project for the log download. */
  project?: string;
  /** Why no log can be fetched for this job. */
  unavailable?: string;
}

export interface LogLimits { maxBytes: number; timeoutMs: number }
/** The last `maxBytes` of a job's log; `bytes` is the full size. */
export interface JobLog { text: string; bytes: number; truncated: boolean }

/** `held` means someone else is already assigned; Sawmill never takes a ticket from them. */
export type AssignResult = { status: 'assigned' } | { status: 'held'; by: string };

export interface TicketWriter {
  addLabel(number: number, label: string): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
  addComment(number: number, body: string): Promise<void>;
  closeTicket(number: number): Promise<void>;
  /** Assign the user the tracker CLI is logged in as; idempotent. */
  assignSelf?(number: number): Promise<AssignResult>;
  /** Every comment on the ticket, oldest first; used by reset to find agent comments. */
  listComments?(number: number): Promise<IssueComment[]>;
  /** Idempotent: a comment that is already gone counts as deleted. */
  deleteComment?(id: number | string, number: number): Promise<void>;
  /** The ticket's current open/closed state; read once, just before its first start. */
  ticketState?(number: number): Promise<Ticket['state']>;
}

/** A definite server refusal, distinct from transport/authentication failures. */
export class MergeRefusedError extends Error {}

/** Shared by GitHub and GitLab; mirror and integration operations arrive separately. */
export interface IntegrationTracker extends TicketWriter {
  /** Required for ci:wait; ci:none adapters need not provide CI reads. */
  getPipeline?(commit: string, changeRequest?: ChangeRequest): Promise<Pipeline>;
  /** Download one verified failed job's log through the tracker's own authentication. */
  getJobLog?(job: CiJob, limits: LogLimits): Promise<JobLog>;
  /** One final PR/MR read before merging; never an issue read or a polling loop. */
  getChangeRequest?(id: number | string): Promise<ChangeRequest>;
  findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }): Promise<ChangeRequest>;
  mergeChangeRequest(id: number | string, method: 'squash' | 'merge', expectedHead?: string): Promise<{ mergeCommit: string }>;
  deleteRemoteBranch(branch: string): Promise<void>;
}

export interface Tracker extends TicketReader, IntegrationTracker {
  listByLabel(label: string): Promise<Ticket[]>;
  listChildren(number: number): Promise<Ticket[]>;
  getPipeline(commit: string, changeRequest?: ChangeRequest): Promise<Pipeline>;
  getChangeRequest(id: number | string): Promise<ChangeRequest>;
}
