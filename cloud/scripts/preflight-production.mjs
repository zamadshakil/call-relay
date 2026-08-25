import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const failures = [];
const database = config.d1_databases?.find((item) => item.binding === "CALL_RELAY_DB");
if (!database || database.database_id === "00000000-0000-0000-0000-000000000000") {
  failures.push("replace the CALL_RELAY_DB database_id with the real D1 database ID");
}
if (!String(config.vars?.LIVEKIT_URL ?? "").startsWith("wss://") || String(config.vars.LIVEKIT_URL).includes("replace-me")) {
  failures.push("set vars.LIVEKIT_URL to the real wss:// LiveKit Cloud URL");
}
if (!config.vars?.FCM_PROJECT_ID || String(config.vars.FCM_PROJECT_ID).includes("replace-me")) {
  failures.push("set vars.FCM_PROJECT_ID to the Firebase project ID");
}
const expectedSecrets = new Set([
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "ENROLLMENT_INVITE",
  "FCM_CLIENT_EMAIL",
  "FCM_PRIVATE_KEY",
]);
for (const item of config.secrets_store_secrets ?? []) expectedSecrets.delete(item.binding);
if (expectedSecrets.size > 0) {
  failures.push(`add Secrets Store bindings for: ${Array.from(expectedSecrets).sort().join(", ")}`);
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
