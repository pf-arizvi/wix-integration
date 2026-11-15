import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (Miniflare) with a local, per-test-isolated D1.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Test-only values; override anything from wrangler.jsonc / .dev.vars.
          bindings: {
            TEST_MIGRATIONS: migrations,
            MINTSOFT_API_KEY: "test-mintsoft-key",
            ADMIN_TOKEN: "test-admin-token-0123456789abcdef0123456789",
            // 32 zero bytes, base64. Never use outside tests.
            ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            WORKER_BASE_URL: "https://worker.test",
            DEBUG_PAYLOADS: "false",
            MINTSOFT_WRITES_ENABLED: "false",
            MINTSOFT_ALLOWED_CLIENT_IDS: "38",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup/apply-migrations.ts"],
    },
  };
});
