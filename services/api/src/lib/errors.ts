/** Error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details);
export const unauthorised = (message = "Sign in to continue") => new AppError(401, "UNAUTHORISED", message);
export const forbidden = (message = "Your role does not allow this action") => new AppError(403, "FORBIDDEN", message);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} was not found`);
export const conflict = (message: string) => new AppError(409, "CONFLICT", message);

/** The network refused a transaction. `reason` is the name of the contract error. */
export class ContractRevert extends AppError {
  constructor(
    readonly reason: string,
    readonly args: readonly unknown[] = [],
  ) {
    super(422, "REJECTED_BY_NETWORK", `The network rejected the transaction: ${reason}`, { reason, args });
    this.name = "ContractRevert";
  }
}
