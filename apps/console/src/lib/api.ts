/** Thin client of the settlement API. Keeps the session token and turns failures into `ApiError`. */

const TOKEN_KEY = "takarail.session";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const session = {
  get token(): string | null {
    return sessionStorage.getItem(TOKEN_KEY);
  },
  set token(value: string | null) {
    if (value === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, value);
  },
};

/** Called when the API no longer accepts the session, so the app can return to the sign-in page. */
let onExpired: () => void = () => undefined;
export const onSessionExpired = (handler: () => void) => {
  onExpired = handler;
};

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(session.token ? { authorization: `Bearer ${session.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as
    (T & { error?: { code: string; message: string; details?: unknown } }) | null;
  if (!response.ok) {
    if (response.status === 401 && session.token) {
      session.token = null;
      onExpired();
    }
    const error = payload?.error;
    throw new ApiError(response.status, error?.code ?? "ERROR", error?.message ?? response.statusText, error?.details);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T = CommandResult>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
};

export interface CommandResult {
  txHash: string;
  blockNumber: string;
}

/** Message to show an operator when a command fails. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : "Something went wrong";
  if (error.code === "VALIDATION" && Array.isArray(error.details)) {
    const issues = error.details as { path: string; message: string }[];
    return issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ");
  }
  return error.message;
}

/** Downloads a report with the session's credentials. */
export async function download(path: string, fileName: string): Promise<void> {
  const response = await fetch(path, { headers: { authorization: `Bearer ${session.token ?? ""}` } });
  if (!response.ok) throw new ApiError(response.status, "DOWNLOAD", "The report could not be downloaded");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
