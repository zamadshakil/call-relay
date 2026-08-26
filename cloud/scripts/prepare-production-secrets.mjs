import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing or empty`);
  return value.trim();
}

function parseValues(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*[:=]\s*(.*?)\s*$/u);
    if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/gu, ""));
  }
  return values;
}

async function writePrivate(path, value) {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  try { await chmod(path, 0o600); } catch { /* Windows uses ACLs; Git ignore remains mandatory. */ }
}

async function savedOrGenerated(path, label) {
  try {
    return required(await readFile(path, "utf8"), `saved ${label}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const value = randomBytes(32).toString("base64url");
    await writePrivate(path, `${value}\n`);
    return value;
  }
}

const firebasePath = resolve(required(option("--firebase"), "--firebase path"));
const turnPath = resolve(required(option("--turn"), "--turn path"));
const outputPath = resolve(option("--output") ?? ".secrets.production.json");
const invitePath = resolve(option("--invite-output") ?? ".enrollment-invite.txt");
const signalPath = resolve(option("--signal-secret-output") ?? ".signal-ticket-secret.txt");
const firebase = JSON.parse(await readFile(firebasePath, "utf8"));
const turn = parseValues(await readFile(turnPath, "utf8"));

const secrets = {
  CF_TURN_KEY_ID: required(turn.get("CF_TURN_KEY_ID"), "CF_TURN_KEY_ID"),
  CF_TURN_API_TOKEN: required(turn.get("CF_TURN_API_TOKEN"), "CF_TURN_API_TOKEN"),
  SIGNAL_TICKET_SECRET: await savedOrGenerated(signalPath, "signaling ticket secret"),
  ENROLLMENT_INVITE: await savedOrGenerated(invitePath, "enrollment invite"),
  FCM_CLIENT_EMAIL: required(firebase.client_email, "Firebase client_email"),
  FCM_PRIVATE_KEY: required(firebase.private_key, "Firebase private_key"),
};

await writePrivate(outputPath, `${JSON.stringify(secrets, null, 2)}\n`);
process.stdout.write(
  `Prepared ${outputPath} with ${Object.keys(secrets).length} secret names; no values were printed.\n` +
  `Saved reusable enrollment and signaling secrets in ignored local files. FCM_PROJECT_ID=${required(firebase.project_id, "Firebase project_id")}.\n`,
);
