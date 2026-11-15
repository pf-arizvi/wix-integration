/** Small helpers for building JSON responses from our own endpoints. */

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorJson(status: number, error: string, message?: string, headers?: Record<string, string>): Response {
  return json(message ? { error, message } : { error }, status, headers);
}
