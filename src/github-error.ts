export class GitHubApiError extends Error {
  constructor(message: string, readonly status: number | undefined) { super(message); }
}
