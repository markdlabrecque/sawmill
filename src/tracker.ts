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

export interface TicketWriter {
  addLabel(number: number, label: string): Promise<void>;
  removeLabel(number: number, label: string): Promise<void>;
  addComment(number: number, body: string): Promise<void>;
  closeTicket(number: number): Promise<void>;
}

/** Shared by GitHub and GitLab; mirror and integration operations arrive separately. */
export interface Tracker extends TicketReader, TicketWriter {
  listByLabel(label: string): Promise<Ticket[]>;
  listChildren(number: number): Promise<Ticket[]>;
  getPipeline(commit: string): Promise<{ state: 'pending' | 'passed' | 'failed' | 'none'; logUrl?: string }>;
  findOrOpenChangeRequest(input: { branch: string; base: string; title: string; body: string }): Promise<ChangeRequest>;
  mergeChangeRequest(id: number | string, method: 'squash' | 'merge'): Promise<{ mergeCommit: string }>;
  deleteRemoteBranch(branch: string): Promise<void>;
}
