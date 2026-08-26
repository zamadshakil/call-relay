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
    LIVEKIT_API_KEY: "integration-api-key",
    LIVEKIT_API_SECRET: "integration-api-secret",
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
