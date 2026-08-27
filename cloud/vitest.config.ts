import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import webpush from "web-push";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fcmPrivateKey = privateKey.export({ type: "pkcs8", format: "pem" });
  const vapid = webpush.generateVAPIDKeys();
  const testSecrets = {
    ENROLLMENT_INVITE: "integration-test-invite",
    CF_TURN_KEY_ID: "integration-turn-key",
    CF_TURN_API_TOKEN: "integration-turn-token",
    SIGNAL_TICKET_SECRET: "integration-signal-ticket-secret-with-32-bytes",
    FCM_CLIENT_EMAIL: "test@example.invalid",
    FCM_PRIVATE_KEY: fcmPrivateKey,
    PADDLE_API_KEY: "pdl_test_integration",
    PADDLE_WEBHOOK_SECRET: "pdl_ntfset_integration",
    SIM_PROFILE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    PUSH_SUBSCRIPTION_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    VAPID_PRIVATE_KEY: vapid.privateKey,
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
            FIREBASE_PROJECT_ID: "integration-project",
            ACCESS_MODE: "paid",
            ONBOARDING_V2_ENABLED: "false",
            MIN_ANDROID_APP_VERSION: "2",
            PUBLIC_APP_URL: "https://relay.test",
            PADDLE_ENVIRONMENT: "sandbox",
            PADDLE_MONTHLY_PRICE_ID: "pri_01h000000000000000000000000",
            PADDLE_ANNUAL_PRICE_ID: "pri_01h111111111111111111111111",
            VAPID_PUBLIC_KEY: vapid.publicKey,
            VAPID_SUBJECT: "mailto:test@example.invalid",
          },
        },
      }),
    ],
    test: {
      include: ["src/**/*.test.ts", "web/**/*.test.ts", "test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      // Worker integration tests exercise real Durable Object WebSockets and
      // crypto. Five seconds is flaky on parallel Windows workerd isolates.
      testTimeout: 15_000,
    },
  };
});
