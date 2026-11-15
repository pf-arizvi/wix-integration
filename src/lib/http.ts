/**
 * The single path for outbound HTTP (Wix, Mintsoft). Adapters only.
 *
 * - Per-attempt timeout via AbortSignal.timeout.
 * - Retry with exponential backoff + jitter on 429 / 5xx / network errors
 *   (honours Retry-After), up to HTTP_MAX_ATTEMPTS total attempts.
 * - Non-idempotent requests (e.g. create order) are retried ONLY on 429, where
 *   the server has not processed the request. A timeout or 5xx on a create may
 *   have succeeded server-side; the flow's duplicate check handles that next run.
 * - Every attempt draws from a per-invocation SubrequestBudget (free plan cap).
 * - Failures throw HttpError: structured, log-safe (no query string, no headers).
 */
import { HTTP_MAX_ATTEMPTS, HTTP_TIMEOUT_MS, SUBREQUEST_BUDGET } from "../config";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpRequest {
  /** Label for logs/errors, e.g. "wix" | "mintsoft". */
  service: string;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** Serialised as JSON. */
  body?: unknown;
  /**
   * Is it safe to send this request twice? Required so each adapter call
   * decides explicitly. Searches/reads: true. Creates: false.
   */
  idempotent: boolean;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  /** Parsed JSON; raw text for non-JSON bodies; undefined when empty. */
  data: T;
}

export type HttpErrorKind = "http" | "timeout" | "network" | "invalid_json" | "budget_exhausted";

export interface HttpErrorInfo {
  kind: HttpErrorKind;
  service: string;
  method: HttpMethod;
  /** origin + pathname only — query strings may carry filters or tokens. */
  url: string;
  status?: number;
  attempts: number;
  /** Parsed error body when JSON (e.g. Wix applicationError codes). */
  body?: unknown;
  /** First 500 chars of the response body, for error_log. */
  bodySnippet?: string;
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  readonly kind: HttpErrorKind;
  readonly service: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly status: number | undefined;
  readonly attempts: number;
  readonly body: unknown;
  readonly bodySnippet: string | undefined;

  constructor(info: HttpErrorInfo, options?: { cause?: unknown }) {
    super(describe(info), options);
    this.kind = info.kind;
    this.service = info.service;
    this.method = info.method;
    this.url = info.url;
    this.status = info.status;
    this.attempts = info.attempts;
    this.body = info.body;
    this.bodySnippet = info.bodySnippet;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      kind: this.kind,
      service: this.service,
      method: this.method,
      url: this.url,
      status: this.status,
      attempts: this.attempts,
      bodySnippet: this.bodySnippet,
    };
  }
}

function describe(i: HttpErrorInfo): string {
  const what = `${i.service} ${i.method} ${i.url}`;
  switch (i.kind) {
    case "http":
      return `${what} failed with HTTP ${i.status} after ${i.attempts} attempt(s)`;
    case "timeout":
      return `${what} timed out after ${i.attempts} attempt(s)`;
    case "network":
      return `${what} network error after ${i.attempts} attempt(s)`;
    case "invalid_json":
      return `${what} returned invalid JSON (HTTP ${i.status})`;
    case "budget_exhausted":
      return `${what} not sent: subrequest budget exhausted`;
  }
}

/** Counts outbound fetches for one invocation. Create one per request/cron run. */
export class SubrequestBudget {
  private used = 0;
  constructor(readonly limit: number = SUBREQUEST_BUDGET) {}
  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }
  /** True if `n` more subrequests fit. Use before starting multi-call work. */
  has(n = 1): boolean {
    return this.remaining >= n;
  }
  /** @internal called by the HTTP client per attempt. */
  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
}

export interface HttpClient {
  readonly budget: SubrequestBudget;
  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>>;
}

export interface HttpClientOptions {
  budget?: SubrequestBudget;
  /** Injected in tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;
const SNIPPET_CHARS = 500;

export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const budget = opts.budget ?? new SubrequestBudget();
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  async function request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    const maxAttempts = Math.max(1, req.maxAttempts ?? HTTP_MAX_ATTEMPTS);
    const timeoutMs = req.timeoutMs ?? HTTP_TIMEOUT_MS;
    const safeUrl = redactUrl(req.url);
    const base = { service: req.service, method: req.method, url: safeUrl };

    const headers: Record<string, string> = { Accept: "application/json", ...req.headers };
    let body: string | undefined;
    if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers["Content-Type"] ??= "application/json";
    }

    for (let attempt = 1; ; attempt++) {
      if (!budget.take()) throw new HttpError({ ...base, kind: "budget_exhausted", attempts: attempt - 1 });
      const canRetry = attempt < maxAttempts;

      let res: Response;
      try {
        res = await doFetch(req.url, {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        const kind = isTimeout(cause) ? "timeout" : "network";
        if (canRetry && req.idempotent) {
          await sleep(backoffMs(attempt, null, random));
          continue;
        }
        throw new HttpError({ ...base, kind, attempts: attempt }, { cause });
      }

      const text = await res.text();

      if (res.ok) {
        return { status: res.status, headers: res.headers, data: parseSuccess<T>(text, res, base, attempt) };
      }

      const retryable = res.status === 429 || (res.status >= 500 && req.idempotent);
      if (retryable && canRetry) {
        await sleep(backoffMs(attempt, res.headers.get("Retry-After"), random));
        continue;
      }
      throw new HttpError({
        ...base,
        kind: "http",
        status: res.status,
        attempts: attempt,
        body: tryParseJson(text),
        bodySnippet: text.slice(0, SNIPPET_CHARS) || undefined,
      });
    }
  }

  return { budget, request };
}

function parseSuccess<T>(
  text: string,
  res: Response,
  base: Pick<HttpErrorInfo, "service" | "method" | "url">,
  attempts: number,
): T {
  if (text === "") return undefined as T;
  const isJson = (res.headers.get("Content-Type") ?? "").includes("json");
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    if (!isJson) return text as T;
    throw new HttpError(
      { ...base, kind: "invalid_json", status: res.status, attempts, bodySnippet: text.slice(0, SNIPPET_CHARS) },
      { cause },
    );
  }
}

function tryParseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Exponential backoff with jitter; honours Retry-After (seconds or HTTP date), capped. */
export function backoffMs(attempt: number, retryAfter: string | null, random: () => number = Math.random): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, BACKOFF_MAX_MS);
  }
  const exp = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(exp + Math.floor(random() * BACKOFF_BASE_MS), BACKOFF_MAX_MS);
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}
