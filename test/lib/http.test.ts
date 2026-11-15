import { describe, expect, it } from "vitest";
import { backoffMs, createHttpClient, HttpError, redactUrl, SubrequestBudget } from "../../src/lib/http";

type Step = Response | Error;

function fakeFetch(steps: Step[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const step = steps.shift();
    if (!step) throw new Error("fakeFetch: no more steps");
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { fn, calls };
}

function jsonRes(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function client(steps: Step[], budget?: SubrequestBudget) {
  const f = fakeFetch(steps);
  const sleeps: number[] = [];
  const http = createHttpClient({
    fetch: f.fn,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    ...(budget ? { budget } : {}),
  });
  return { http, calls: f.calls, sleeps };
}

const GET = { service: "test", method: "GET", url: "https://api.example.com/x?secret=1", idempotent: true } as const;
const CREATE = { service: "test", method: "PUT", url: "https://api.example.com/order", idempotent: false } as const;

describe("http client", () => {
  it("returns parsed JSON and sends JSON headers", async () => {
    const { http, calls } = client([jsonRes(200, { ok: 1 })]);
    const res = await http.request<{ ok: number }>({ ...CREATE, body: { a: 1 } });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: 1 });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(calls[0]!.init!.body).toBe('{"a":1}');
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns undefined data for empty bodies", async () => {
    const { http } = client([new Response(null, { status: 204 })]);
    expect((await http.request(GET)).data).toBeUndefined();
  });

  it("retries idempotent requests on 5xx with backoff, then succeeds", async () => {
    const { http, calls, sleeps } = client([jsonRes(503, {}), jsonRes(502, {}), jsonRes(200, { ok: true })]);
    const res = await http.request(GET);
    expect(res.data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("does NOT retry non-idempotent requests on 5xx", async () => {
    const { http, calls } = client([jsonRes(500, { message: "boom" })]);
    const err = await http.request(CREATE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ kind: "http", status: 500, attempts: 1, body: { message: "boom" } });
    expect(calls).toHaveLength(1);
  });

  it("retries non-idempotent requests on 429 and honours Retry-After", async () => {
    const { http, calls, sleeps } = client([jsonRes(429, {}, { "Retry-After": "2" }), jsonRes(200, { id: 7 })]);
    expect((await http.request(CREATE)).data).toEqual({ id: 7 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up after max attempts with a structured, redacted error", async () => {
    const { http, calls } = client([jsonRes(503, {}), jsonRes(503, {}), jsonRes(503, { e: "still down" })]);
    const err = (await http.request(GET).catch((e: unknown) => e)) as HttpError;
    expect(calls).toHaveLength(3);
    expect(err.toJSON()).toMatchObject({
      kind: "http",
      service: "test",
      method: "GET",
      url: "https://api.example.com/x",
      status: 503,
      attempts: 3,
      bodySnippet: '{"e":"still down"}',
    });
    expect(err.message).not.toContain("secret");
  });

  it("does not retry 4xx other than 429", async () => {
    const { http, calls } = client([jsonRes(409, { code: "DUP" })]);
    const err = (await http.request(GET).catch((e: unknown) => e)) as HttpError;
    expect(err.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("classifies timeouts and retries them only when idempotent", async () => {
    const timeout = () => new DOMException("timed out", "TimeoutError");
    const a = client([timeout(), jsonRes(200, { ok: 1 })]);
    expect((await a.http.request(GET)).data).toEqual({ ok: 1 });

    const b = client([timeout()]);
    const err = (await b.http.request(CREATE).catch((e: unknown) => e)) as HttpError;
    expect(err.kind).toBe("timeout");
    expect(b.calls).toHaveLength(1);
  });

  it("classifies network errors", async () => {
    const { http } = client([new TypeError("fetch failed")]);
    const err = (await http.request({ ...GET, maxAttempts: 1 }).catch((e: unknown) => e)) as HttpError;
    expect(err.kind).toBe("network");
  });

  it("throws invalid_json when a JSON content-type body does not parse", async () => {
    const bad = new Response("{nope", { status: 200, headers: { "Content-Type": "application/json" } });
    const { http } = client([bad]);
    const err = (await http.request(GET).catch((e: unknown) => e)) as HttpError;
    expect(err.kind).toBe("invalid_json");
  });

  it("returns raw text for non-JSON bodies", async () => {
    const { http } = client([new Response("OK", { status: 200, headers: { "Content-Type": "text/plain" } })]);
    expect((await http.request(GET)).data).toBe("OK");
  });

  it("counts every attempt against the subrequest budget and stops when exhausted", async () => {
    const budget = new SubrequestBudget(2);
    const { http, calls } = client([jsonRes(503, {}), jsonRes(503, {}), jsonRes(200, {})], budget);
    const err = (await http.request(GET).catch((e: unknown) => e)) as HttpError;
    expect(err.kind).toBe("budget_exhausted");
    expect(calls).toHaveLength(2);
    expect(budget.remaining).toBe(0);
    expect(budget.has()).toBe(false);
  });
});

describe("backoffMs", () => {
  it("grows exponentially and caps", () => {
    expect(backoffMs(1, null, () => 0)).toBe(500);
    expect(backoffMs(2, null, () => 0)).toBe(1000);
    expect(backoffMs(10, null, () => 0)).toBe(8000);
  });
  it("caps Retry-After", () => {
    expect(backoffMs(1, "120")).toBe(8000);
  });
});

describe("redactUrl", () => {
  it("strips query strings", () => {
    expect(redactUrl("https://a.test/p/q?token=abc")).toBe("https://a.test/p/q");
  });
});
