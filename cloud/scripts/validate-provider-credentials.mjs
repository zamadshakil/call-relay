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

function parseLiveKit(text) {
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
const liveKitPath = resolve(required(option("--livekit"), "--livekit path"));
const firebase = JSON.parse(await readFile(firebasePath, "utf8"));
const liveKit = parseLiveKit(await readFile(liveKitPath, "utf8"));
const issuedAt = Math.floor(Date.now() / 1000);

const firebaseKey = await importPKCS8(required(firebase.private_key, "Firebase private_key"), "RS256");
const firebaseAssertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
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
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: firebaseAssertion,
  }),
});
const firebaseBody = await responseJson(firebaseResponse);
if (!firebaseResponse.ok || typeof firebaseBody.access_token !== "string") {
  throw new Error(`Firebase messaging OAuth validation failed with HTTP ${firebaseResponse.status}`);
}

const liveKitUrl = new URL(required(liveKit.get("LIVEKIT_URL"), "LIVEKIT_URL"));
liveKitUrl.protocol = "https:";
const liveKitToken = await new SignJWT({ video: { roomList: true } })
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setIssuer(required(liveKit.get("LIVEKIT_API_KEY"), "LIVEKIT_API_KEY"))
  .setSubject("call-relay-provider-validation")
  .setIssuedAt(issuedAt)
  .setNotBefore(issuedAt - 5)
  .setExpirationTime(issuedAt + 60)
  .sign(new TextEncoder().encode(required(liveKit.get("LIVEKIT_API_SECRET"), "LIVEKIT_API_SECRET")));
const liveKitResponse = await fetch(new URL("/twirp/livekit.RoomService/ListRooms", liveKitUrl), {
  method: "POST",
  headers: {
    authorization: `Bearer ${liveKitToken}`,
    "content-type": "application/json",
  },
  body: "{}",
});
const liveKitBody = await responseJson(liveKitResponse);
if (!liveKitResponse.ok || !Array.isArray(liveKitBody.rooms)) {
  throw new Error(`LiveKit RoomService validation failed with HTTP ${liveKitResponse.status}`);
}

process.stdout.write("Firebase service-account signing and messaging-scope OAuth validation passed.\n");
process.stdout.write(`LiveKit API key/secret validation passed; visible rooms: ${liveKitBody.rooms.length}.\n`);
process.stdout.write("No credential values were printed.\n");
