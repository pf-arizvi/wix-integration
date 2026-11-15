/** Small helpers for building JSON responses from our own endpoints. */

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

const MAX_BODY_BYTES = 64 * 1024;

/** Parses a JSON object body. Returns null if missing, too large, invalid or not an object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (!text || text.length > MAX_BODY_BYTES) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function errorJson(status: number, error: string, message?: string, headers?: Record<string, string>): Response {
  return json(message ? { error, message } : { error }, status, headers);
}
