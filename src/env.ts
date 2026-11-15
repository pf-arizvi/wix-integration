/**
 * Worker bindings, vars and secrets.
 *
 * Hand-written (not generated) so secrets are typed without needing a local
 * .dev.vars. `npm run types` regenerates runtime types only.
 * Keep in sync with wrangler.jsonc and .dev.vars.example.
 */
export interface Env {
  // Bindings
  DB: D1Database;

  // Vars (wrangler.jsonc). Always strings; parse via src/config.ts.
  MAX_ORDERS_PER_RUN: string;
  DEBUG_PAYLOADS: string;
  WORKER_BASE_URL: string;

  // Secrets (`wrangler secret put` / .dev.vars)
  MINTSOFT_API_KEY: string;
  ADMIN_TOKEN: string;
  /** 32-byte key, base64. AES-GCM for client Wix API keys at rest. */
  ENCRYPTION_KEY: string;
}

// Lets `import { env, exports } from "cloudflare:workers"` (used in tests) see our types.
type WorkerEnv = Env;
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}
