import { importPKCS8, SignJWT } from "jose";
import { secretValue } from "./secrets";
import type { Env } from "./types";

interface OAuthTokenResponse {
  access_token?: unknown;
}

export async function googleAccessToken(env: Env, scopes: string[]): Promise<string> {
  const clientEmail = await secretValue(env.FCM_CLIENT_EMAIL, "FCM_CLIENT_EMAIL");
  const privateKey = await secretValue(env.FCM_PRIVATE_KEY, "FCM_PRIVATE_KEY");
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(privateKey.replaceAll("\\n", "\n"), "RS256");
  const assertion = await new SignJWT({ scope: scopes.join(" ") })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(clientEmail)
    .setSubject(clientEmail)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`Google OAuth failed (${response.status})`);
  const value: OAuthTokenResponse = await response.json();
  if (typeof value.access_token !== "string" || value.access_token.length === 0) {
    throw new Error("Google OAuth returned an invalid access token response");
  }
  return value.access_token;
}
