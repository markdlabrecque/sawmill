export class CliError extends Error {
  constructor(message: string, public readonly exitCode: 1 | 2 = 1) {
    super(message);
  }
}

/** A failure that retrying cannot fix; infrastructure retries stop at once. */
export class FinalError extends Error {}
