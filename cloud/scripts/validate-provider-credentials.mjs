import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SignJWT, importPKCS8 } from "jose";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing`);
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

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

const firebasePath = resolve(required(option("--firebase"), "--firebase path"));
const turnPath = resolve(required(option("--turn"), "--turn path"));
const firebase = JSON.parse(await readFile(firebasePath, "utf8"));
const turn = parseValues(await readFile(turnPath, "utf8"));
const turnKeyId = required(turn.get("CF_TURN_KEY_ID"), "CF_TURN_KEY_ID");
const turnToken = required(turn.get("CF_TURN_API_TOKEN"), "CF_TURN_API_TOKEN");
const issuedAt = Math.floor(Date.now() / 1000);

const firebaseKey = await importPKCS8(required(firebase.private_key, "Firebase private_key"), "RS256");
const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
  .setProtectedHeader({ alg: "RS256", typ: "JWT" })
  .setIssuer(required(firebase.client_email, "Firebase client_email"))
  .setSubject(firebase.client_email)
  .setAudience(required(firebase.token_uri, "Firebase token_uri"))
  .setIssuedAt(issuedAt)
  .setExpirationTime(issuedAt + 3600)
  .sign(firebaseKey);
const firebaseResponse = await fetch(firebase.token_uri, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
});
const firebaseBody = await responseJson(firebaseResponse);
if (!firebaseResponse.ok || typeof firebaseBody.access_token !== "string") {
  throw new Error(`Firebase messaging OAuth validation failed (${firebaseResponse.status})`);
}

const turnOrigin = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials`;
const turnResponse = await fetch(`${turnOrigin}/generate`, {
  method: "POST",
  headers: { authorization: `Bearer ${turnToken}`, "content-type": "application/json" },
  body: JSON.stringify({ ttl: 120, customIdentifier: "provider-validation" }),
});
const credential = await responseJson(turnResponse);
if (!turnResponse.ok || typeof credential.username !== "string" || typeof credential.credential !== "string") {
  throw new Error(`Cloudflare TURN credential validation failed (${turnResponse.status})`);
}
const revokeResponse = await fetch(`${turnOrigin}/${encodeURIComponent(credential.username)}/revoke`, {
  method: "POST",
  headers: { authorization: `Bearer ${turnToken}` },
});
if (!revokeResponse.ok) throw new Error(`Cloudflare TURN revoke validation failed (${revokeResponse.status})`);

process.stdout.write("Firebase OAuth and Cloudflare TURN generation/revocation validation passed. No credential values were printed.\n");
