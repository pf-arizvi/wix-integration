import type { ErrorCode } from "../errorCodes";

/** Thrown when a guardrail detects real (or likely) damage. Stops the whole run. */
export class ImportHaltedError extends Error {
  override readonly name = "ImportHaltedError";
}

/** Configuration prevents the flow from running for this client. Nothing was attempted. */
export class ImportConfigError extends Error {
  override readonly name = "ImportConfigError";
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
