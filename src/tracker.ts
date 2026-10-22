export interface TicketComment {
  body: string;
  author?: string;
  createdAt?: string;
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
  /** Return all matching tickets, including closed tickets, with complete threads. */
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
}

export interface TicketWriter {
  addLabel(number: number, label: string): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
  addComment(number: number, body: string): Promise<void>;
  closeTicket(number: number): Promise<void>;
}

/** A definite server refusal, distinct from transport/authentication failures. */
export class MergeRefusedError extends Error {}

/** Shared by GitHub and GitLab; mirror and integration operations arrive separately. */
export interface IntegrationTracker extends TicketWriter {
  /** Required for ci:wait; ci:none adapters need not provide CI reads. */
  getPipeline?(commit: string): Promise<Pipeline>;
  /** One final PR/MR read before merging; never an issue read or a polling loop. */
  getChangeRequest?(id: number | string): Promise<ChangeRequest>;
  findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }): Promise<ChangeRequest>;
  mergeChangeRequest(id: number | string, method: 'squash' | 'merge', expectedHead?: string): Promise<{ mergeCommit: string }>;
  deleteRemoteBranch(branch: string): Promise<void>;
}

export interface Tracker extends TicketReader, IntegrationTracker {
  listByLabel(label: string): Promise<Ticket[]>;
  listChildren(number: number): Promise<Ticket[]>;
  getPipeline(commit: string): Promise<Pipeline>;
  getChangeRequest(id: number | string): Promise<ChangeRequest>;
}
