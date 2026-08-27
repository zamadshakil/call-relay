import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const failures = [];
const database = config.d1_databases?.find((item) => item.binding === "CALL_RELAY_DB");
if (!database || database.database_id === "00000000-0000-0000-0000-000000000000") {
  failures.push("replace the CALL_RELAY_DB database_id with the real D1 database ID");
}
if (!config.vars?.FCM_PROJECT_ID || String(config.vars.FCM_PROJECT_ID).includes("replace-me")) {
  failures.push("set vars.FCM_PROJECT_ID to the Firebase project ID");
}
if (!config.vars?.FIREBASE_PROJECT_ID || String(config.vars.FIREBASE_PROJECT_ID).includes("replace-me")) {
  failures.push("set vars.FIREBASE_PROJECT_ID to the Firebase project ID");
}
if (!/^pri_[a-z0-9]{26}$/u.test(String(config.vars?.PADDLE_MONTHLY_PRICE_ID ?? "")) ||
    !/^pri_[a-z0-9]{26}$/u.test(String(config.vars?.PADDLE_ANNUAL_PRICE_ID ?? ""))) {
  failures.push("set production Paddle monthly and annual price IDs");
}
if (config.vars?.PADDLE_ENVIRONMENT !== "production") failures.push("set production PADDLE_ENVIRONMENT to production");
const onboardingV2Enabled = config.vars?.ONBOARDING_V2_ENABLED === "true";
if (!onboardingV2Enabled) failures.push("enable ONBOARDING_V2_ENABLED only at the approved production cutover");
if (Number(config.vars?.MIN_ANDROID_APP_VERSION) < 3) failures.push("set MIN_ANDROID_APP_VERSION to 3 or newer");
const expectedSecrets = [
  "CF_TURN_KEY_ID",
  "CF_TURN_API_TOKEN",
  "SIGNAL_TICKET_SECRET",
  "FCM_CLIENT_EMAIL",
  "FCM_PRIVATE_KEY",
  "PADDLE_API_KEY",
  "PADDLE_WEBHOOK_SECRET",
  "SIM_PROFILE_ENCRYPTION_KEY",
];
const declaredSecrets = new Set(config.secrets?.required ?? []);
if (!onboardingV2Enabled) expectedSecrets.push("ENROLLMENT_INVITE");
const missingSecretDeclarations = expectedSecrets.filter((name) => !declaredSecrets.has(name));
if (missingSecretDeclarations.length > 0) {
  failures.push(`declare required Worker secrets for: ${missingSecretDeclarations.sort().join(", ")}`);
}
if (onboardingV2Enabled && declaredSecrets.has("ENROLLMENT_INVITE")) {
  failures.push("remove the obsolete ENROLLMENT_INVITE declaration after onboarding v2 is enabled");
}
const producer = config.queues?.producers?.find((item) => item.binding === "PUSH_QUEUE");
const consumer = config.queues?.consumers?.find((item) => item.queue === producer?.queue);
if (!producer || !consumer?.dead_letter_queue) failures.push("configure the push Queue producer, consumer, and dead-letter queue");

if (failures.length > 0) {
  process.stderr.write(`Production preflight failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Production configuration preflight passed.\n");
}
