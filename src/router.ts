/**
 * Tiny hand-rolled router: exact segments + `:param` captures. No regex per
 * request, no dependencies — keeps CPU per request negligible.
 */
import type { Env } from "./env";
import { requireAdmin } from "./lib/auth";
import { errorJson } from "./lib/response";

export type Params = Record<string, string>;

export interface RouteContext {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  params: Params;
  url: URL;
}

export type Handler = (c: RouteContext) => Response | Promise<Response>;

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Route {
  method: Method;
  segments: string[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }
  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }
  put(pattern: string, handler: Handler): this {
    return this.add("PUT", pattern, handler);
  }
  delete(pattern: string, handler: Handler): this {
    return this.add("DELETE", pattern, handler);
  }

  private add(method: Method, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: split(pattern), handler });
    return this;
  }

  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = split(url.pathname);
    let pathMatched = false;

    for (const route of this.routes) {
      const params = match(route.segments, path);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== request.method) continue;
      return route.handler({ request, env, ctx, params, url });
    }
    return pathMatched ? errorJson(405, "method_not_allowed") : errorJson(404, "not_found");
  }
}

/** Wraps a handler so it only runs with a valid admin bearer token. */
export function adminOnly(handler: Handler): Handler {
  return async (c) => (await requireAdmin(c.request, c.env)) ?? handler(c);
}

function split(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function match(pattern: string[], path: string[]): Params | null {
  if (pattern.length !== path.length) return null;
  const params: Params = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    const s = path[i]!;
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(s);
      } catch {
        return null;
      }
    } else if (p !== s) {
      return null;
    }
  }
  return params;
}
