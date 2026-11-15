/**
 * Structured JSON logging (one line per event) for Workers Logs.
 *
 * Log IDs, statuses, counts and error text — never addresses, emails, phone
 * numbers or API keys. Raw payloads only via webhook_log when DEBUG_PAYLOADS=true.
 */

type Level = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

function emit(level: Level, event: string, fields?: LogFields): void {
  const line = JSON.stringify({ level, event, ...normalise(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function normalise(fields?: LogFields): LogFields | undefined {
  if (!fields) return undefined;
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v instanceof Error ? serialiseError(v) : v;
  return out;
}

export function serialiseError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const json = (err as { toJSON?: () => Record<string, unknown> }).toJSON;
    return typeof json === "function" ? json.call(err) : { name: err.name, message: err.message };
  }
  return { message: String(err) };
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};
