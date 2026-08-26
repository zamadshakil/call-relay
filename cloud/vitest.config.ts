import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fcmPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" });
  const testSecrets = {
    ENROLLMENT_INVITE: "integration-test-invite",
    CF_TURN_KEY_ID: "integration-turn-key",
    CF_TURN_API_TOKEN: "integration-turn-token",
    SIGNAL_TICKET_SECRET: "integration-signal-ticket-secret-with-32-bytes",
    FCM_CLIENT_EMAIL: "test@example.invalid",
    FCM_PRIVATE_KEY: fcmPrivateKey,
  };
  Object.assign(process.env, testSecrets);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ...testSecrets,
            FCM_PROJECT_ID: "integration-project",
          },
        },
      }),
    ],
    test: {
      include: ["src/**/*.test.ts", "web/**/*.test.ts", "test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
