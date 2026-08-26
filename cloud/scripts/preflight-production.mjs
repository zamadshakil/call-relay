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
const expectedSecrets = [
  "CF_TURN_KEY_ID",
  "CF_TURN_API_TOKEN",
  "SIGNAL_TICKET_SECRET",
  "ENROLLMENT_INVITE",
  "FCM_CLIENT_EMAIL",
  "FCM_PRIVATE_KEY",
];
const declaredSecrets = new Set(config.secrets?.required ?? []);
const missingSecretDeclarations = expectedSecrets.filter((name) => !declaredSecrets.has(name));
if (missingSecretDeclarations.length > 0) {
  failures.push(`declare required Worker secrets for: ${missingSecretDeclarations.sort().join(", ")}`);
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
