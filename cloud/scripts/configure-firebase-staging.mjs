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

async function jsonResponse(response, operation, allowed = []) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok && !allowed.includes(response.status)) {
    const message = body?.error?.message ?? response.statusText;
    throw new Error(`${operation} failed with HTTP ${response.status}: ${message}`);
  }
  return { body, status: response.status };
}

async function waitForOperation(name, authorization) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { body } = await jsonResponse(
      await fetch(`https://firebase.googleapis.com/v1beta1/${name}`, { headers: authorization }),
      "Firebase operation polling",
    );
    if (body.done === true) {
      if (body.error) throw new Error(`Firebase operation failed: ${body.error.message ?? "unknown error"}`);
      return body.response;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error("Firebase app provisioning did not finish within 30 seconds");
}

const serviceAccountPath = resolve(required(option("--service-account"), "--service-account path"));
const androidOutput = resolve(option("--android-output") ?? "../android/app/google-services.json");
const webOutput = resolve(option("--web-output") ?? ".env.staging");
const packageName = option("--package") ?? "dev.zamad.callrelay";
const sha1 = required(option("--sha1"), "--sha1");
const sha256 = required(option("--sha256"), "--sha256");
const serviceAccount = JSON.parse(await readFile(serviceAccountPath, "utf8"));
const projectId = required(serviceAccount.project_id, "Firebase project_id");
const clientEmail = required(serviceAccount.client_email, "Firebase client_email");
const tokenUri = required(serviceAccount.token_uri, "Firebase token_uri");
const privateKey = await importPKCS8(required(serviceAccount.private_key, "Firebase private_key"), "RS256");
const issuedAt = Math.floor(Date.now() / 1000);
const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase" })
  .setProtectedHeader({ alg: "RS256", typ: "JWT" })
  .setIssuer(clientEmail)
  .setSubject(clientEmail)
  .setAudience(tokenUri)
  .setIssuedAt(issuedAt)
  .setExpirationTime(issuedAt + 3600)
  .sign(privateKey);
const { body: token } = await jsonResponse(
  await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  }),
  "OAuth token exchange",
);
const authorization = { Authorization: `Bearer ${required(token.access_token, "OAuth access_token")}` };

const { body: androidApps } = await jsonResponse(
  await fetch(`https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/androidApps`, { headers: authorization }),
  "Firebase Android app listing",
);
const androidApp = (androidApps.apps ?? []).find((candidate) => candidate.packageName === packageName && candidate.state !== "DELETED");
if (!androidApp) throw new Error(`Firebase has no Android app for ${packageName}`);

const { body: shaList } = await jsonResponse(
  await fetch(`https://firebase.googleapis.com/v1beta1/${androidApp.name}/sha`, { headers: authorization }),
  "Firebase SHA certificate listing",
);
for (const certificate of [
  { shaHash: sha1, certType: "SHA_1" },
  { shaHash: sha256, certType: "SHA_256" },
]) {
  const exists = (shaList.certificates ?? []).some((entry) => entry.shaHash === certificate.shaHash);
  if (!exists) {
    await jsonResponse(
      await fetch(`https://firebase.googleapis.com/v1beta1/${androidApp.name}/sha`, {
        method: "POST",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify(certificate),
      }),
      `Firebase ${certificate.certType} registration`,
      [409],
    );
  }
}

const { body: webApps } = await jsonResponse(
  await fetch(`https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/webApps`, { headers: authorization }),
  "Firebase Web app listing",
);
let webApp = (webApps.apps ?? []).find((candidate) => candidate.state !== "DELETED");
if (!webApp) {
  const { body: operation } = await jsonResponse(
    await fetch(`https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}/webApps`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Call Relay Web" }),
    }),
    "Firebase Web app creation",
  );
  webApp = await waitForOperation(required(operation.name, "Firebase operation name"), authorization);
}

const { body: webConfig } = await jsonResponse(
  await fetch(`https://firebase.googleapis.com/v1beta1/${webApp.name}/config`, { headers: authorization }),
  "Firebase Web config download",
);
const webEnv = [
  `VITE_FIREBASE_API_KEY=${required(webConfig.apiKey, "Firebase Web apiKey")}`,
  `VITE_FIREBASE_AUTH_DOMAIN=${required(webConfig.authDomain, "Firebase Web authDomain")}`,
  `VITE_FIREBASE_PROJECT_ID=${required(webConfig.projectId, "Firebase Web projectId")}`,
  `VITE_FIREBASE_WEB_APP_ID=${required(webConfig.appId, "Firebase Web appId")}`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID=${required(webConfig.messagingSenderId, "Firebase Web messagingSenderId")}`,
  "",
].join("\n");
await writeFile(webOutput, webEnv, "utf8");

const authConfigUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(projectId)}/config`;
const { body: authConfig, status: authConfigStatus } = await jsonResponse(
  await fetch(authConfigUrl, { headers: authorization }),
  "Firebase Auth configuration lookup",
  [403, 404],
);
if (authConfigStatus === 200) {
  const requiredDomains = [
    "call-relay.zamadshakil.workers.dev",
    "call-relay-staging.zamadshakil.workers.dev",
  ];
  const authorizedDomains = [...new Set([...(authConfig.authorizedDomains ?? []), ...requiredDomains])];
  if (authorizedDomains.length !== (authConfig.authorizedDomains ?? []).length) {
    await jsonResponse(
      await fetch(`${authConfigUrl}?updateMask=authorizedDomains`, {
        method: "PATCH",
        headers: { ...authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: `projects/${projectId}/config`, authorizedDomains }),
      }),
      "Firebase Auth authorized-domain update",
    );
  }
}

const providerUrl = `https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(projectId)}/defaultSupportedIdpConfigs/google.com`;
const { body: provider, status: providerStatus } = await jsonResponse(
  await fetch(providerUrl, { headers: authorization }),
  "Firebase Google provider lookup",
  [403, 404],
);
if (providerStatus === 200 && provider.enabled !== true) {
  await jsonResponse(
    await fetch(`${providerUrl}?updateMask=enabled`, {
      method: "PATCH",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ name: `projects/${projectId}/defaultSupportedIdpConfigs/google.com`, enabled: true }),
    }),
    "Firebase Google provider enablement",
  );
}

const { body: androidConfig } = await jsonResponse(
  await fetch(`https://firebase.googleapis.com/v1beta1/${androidApp.name}/config`, { headers: authorization }),
  "Firebase Android config download",
);
const decodedAndroid = Buffer.from(required(androidConfig.configFileContents, "Android config contents"), "base64").toString("utf8");
await writeFile(androidOutput, decodedAndroid.endsWith("\n") ? decodedAndroid : `${decodedAndroid}\n`, "utf8");
const parsedAndroid = JSON.parse(decodedAndroid);
const oauthClients = (parsedAndroid.client ?? []).flatMap((client) => client.oauth_client ?? []);

process.stdout.write("Firebase staging setup completed without printing credential values.\n");
process.stdout.write(`Google provider status=${providerStatus}; enabled=${providerStatus === 200 && provider.enabled === true}.\n`);
process.stdout.write(`Android OAuth clients=${oauthClients.length}; Web OAuth clients=${oauthClients.filter((client) => client.client_type === 3).length}.\n`);
