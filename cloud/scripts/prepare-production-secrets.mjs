import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is missing or empty`);
  }
  return value.trim();
}

function parseLiveKit(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*[:=]\s*(.*?)\s*$/u);
    if (!match) continue;
    values.set(match[1], match[2].replace(/^['"]|['"]$/gu, ""));
  }
  return values;
}

async function writePrivate(path, value) {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Windows ACLs are not represented by POSIX modes; Git ignore remains mandatory.
  }
}

const firebasePath = resolve(required(option("--firebase"), "--firebase path"));
const liveKitPath = resolve(required(option("--livekit"), "--livekit path"));
const outputPath = resolve(option("--output") ?? ".secrets.production.json");
const invitePath = resolve(option("--invite-output") ?? ".enrollment-invite.txt");

const firebase = JSON.parse(await readFile(firebasePath, "utf8"));
const liveKit = parseLiveKit(await readFile(liveKitPath, "utf8"));

const liveKitUrl = required(liveKit.get("LIVEKIT_URL"), "LIVEKIT_URL");
if (!liveKitUrl.startsWith("wss://")) throw new Error("LIVEKIT_URL must start with wss://");

let enrollmentInvite;
try {
  enrollmentInvite = required(await readFile(invitePath, "utf8"), "saved enrollment invite");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  enrollmentInvite = randomBytes(32).toString("base64url");
  await writePrivate(invitePath, `${enrollmentInvite}\n`);
}

const secrets = {
  LIVEKIT_API_KEY: required(liveKit.get("LIVEKIT_API_KEY"), "LIVEKIT_API_KEY"),
  LIVEKIT_API_SECRET: required(liveKit.get("LIVEKIT_API_SECRET"), "LIVEKIT_API_SECRET"),
  ENROLLMENT_INVITE: enrollmentInvite,
  FCM_CLIENT_EMAIL: required(firebase.client_email, "Firebase client_email"),
  FCM_PRIVATE_KEY: required(firebase.private_key, "Firebase private_key"),
};

await writePrivate(outputPath, `${JSON.stringify(secrets, null, 2)}\n`);

process.stdout.write(
  [
    `Prepared ${outputPath} with ${Object.keys(secrets).length} required secret names.`,
    `Saved the reusable enrollment invite at ${invitePath}.`,
    `Detected public configuration: LIVEKIT_URL=${liveKitUrl}, FCM_PROJECT_ID=${required(firebase.project_id, "Firebase project_id")}.`,
    "No secret values were printed.",
  ].join("\n") + "\n",
);
