import { readFile, writeFile } from "node:fs/promises";
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

async function jsonResponse(response, operation) {
  const body = await response.json();
  if (!response.ok) {
    const message = body?.error?.message ?? response.statusText;
    throw new Error(`${operation} failed with HTTP ${response.status}: ${message}`);
  }
  return body;
}

const serviceAccountPath = resolve(required(option("--service-account"), "--service-account path"));
const packageName = option("--package") ?? "dev.zamad.callrelay";
const outputPath = resolve(option("--output") ?? "../android/app/google-services.json");
const serviceAccount = JSON.parse(await readFile(serviceAccountPath, "utf8"));
const projectId = required(serviceAccount.project_id, "Firebase project_id");
const clientEmail = required(serviceAccount.client_email, "Firebase client_email");
const tokenUri = required(serviceAccount.token_uri, "Firebase token_uri");
const privateKey = await importPKCS8(required(serviceAccount.private_key, "Firebase private_key"), "RS256");
const issuedAt = Math.floor(Date.now() / 1000);
const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.readonly" })
  .setProtectedHeader({ alg: "RS256", typ: "JWT" })
  .setIssuer(clientEmail)
  .setSubject(clientEmail)
  .setAudience(tokenUri)
  .setIssuedAt(issuedAt)
  .setExpirationTime(issuedAt + 3600)
  .sign(privateKey);

const token = await jsonResponse(
  await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  }),
  "OAuth token exchange",
);

const authorization = { Authorization: `Bearer ${required(token.access_token, "OAuth access_token")}` };
const apps = await jsonResponse(
  await fetch(`https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/androidApps`, {
    headers: authorization,
  }),
  "Firebase Android app listing",
);
const app = (apps.apps ?? []).find((candidate) => candidate.packageName === packageName && candidate.state !== "DELETED");
if (!app) {
  const existing = (apps.apps ?? []).map((candidate) => candidate.packageName).filter(Boolean).join(", ") || "none";
  throw new Error(`Firebase has no Android app for ${packageName}. Existing Android packages: ${existing}`);
}

const config = await jsonResponse(
  await fetch(`https://firebase.googleapis.com/v1beta1/${app.name}/config`, { headers: authorization }),
  "Firebase Android config download",
);
const decoded = Buffer.from(required(config.configFileContents, "configFileContents"), "base64").toString("utf8");
const parsed = JSON.parse(decoded);
const matchingClient = parsed.client?.some(
  (client) => client.client_info?.android_client_info?.package_name === packageName,
);
if (parsed.project_info?.project_id !== projectId || !matchingClient) {
  throw new Error("Downloaded Firebase config does not match the expected project and Android package");
}

await writeFile(outputPath, decoded.endsWith("\n") ? decoded : `${decoded}\n`, "utf8");
process.stdout.write(`Downloaded ${config.configFilename ?? "google-services.json"} for ${packageName} to ${outputPath}.\n`);
process.stdout.write("No service-account credential values were printed.\n");
