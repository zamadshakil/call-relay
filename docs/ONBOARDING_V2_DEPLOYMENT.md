# Gmail, billing, and automatic pairing deployment

## Approval-only testing (no payment)

Set `ACCESS_MODE` to `approval_only` in the selected Wrangler environment. An email in `approved_emails` then receives relay access immediately after Google sign-in; no Paddle keys, product IDs, checkout, webhook, or customer portal are used. Unknown and suspended accounts remain blocked. Switch to `paid` only when billing is intentionally enabled and all Paddle production requirements are ready.

The onboarding-v2 code is additive. Keep `ONBOARDING_V2_ENABLED=false` while staging is configured; that keeps the legacy test APK usable. The new authenticated endpoints still work. Set the flag to `true` only after the new APK/PWA passes staging, which makes manual enrollment return `410 Gone`.

## 1. Firebase Google authentication

In Firebase project `call-relay-3dec7`:

1. Open **Authentication → Sign-in method → Google**, enable it, choose the support email, and save.
2. Open **Project settings → Your apps → Android app** for `dev.zamad.callrelay`.
3. Register the debug and release SHA-1 and SHA-256 fingerprints. Obtain the debug values locally with:

   ```powershell
   & "E:\Android\jdk\jdk-17.0.20.1+1\bin\keytool.exe" -list -v -alias androiddebugkey -keystore "$env:USERPROFILE\.android\debug.keystore" -storepass android -keypass android
   ```

4. Download the regenerated `google-services.json` and place it at `android\app\google-services.json`. It must contain OAuth clients; the currently supplied file has none and cannot sign in with Google.
5. Add a Firebase **Web app**, then copy its public web configuration into an ignored `cloud\.env.staging`:

   ```dotenv
   VITE_FIREBASE_API_KEY=...
   VITE_FIREBASE_AUTH_DOMAIN=call-relay-staging.zamadshakil.workers.dev
   VITE_FIREBASE_PROJECT_ID=call-relay-3dec7
   VITE_FIREBASE_WEB_APP_ID=...
   VITE_FIREBASE_MESSAGING_SENDER_ID=90866288123
   VITE_PADDLE_CLIENT_TOKEN=test_...
   VITE_PADDLE_ENVIRONMENT=sandbox
   ```

6. In **Google Cloud Console → Google Auth Platform → Clients**, open the Web OAuth client used by Firebase Google sign-in and add these exact values:

   Authorized JavaScript origins:

   ```text
   https://call-relay-staging.zamadshakil.workers.dev
   https://call-relay.zamadshakil.workers.dev
   ```

   Authorized redirect URIs:

   ```text
   https://call-relay-staging.zamadshakil.workers.dev/__/auth/handler
   https://call-relay.zamadshakil.workers.dev/__/auth/handler
   ```

   Keep the existing Firebase Hosting handler URI. The Worker transparently proxies `/__/auth/*` to `call-relay-3dec7.firebaseapp.com`; the same-origin `authDomain` is required for redirect sign-in on browsers that block third-party storage, including current Safari and Chrome.
7. In Firebase Authentication settings, keep both Worker hostnames in **Authorized domains**.

The Worker verifies Firebase JWT signature, algorithm, issuer, audience, expiry, UID, `email_verified`, disabled status, and revocation time. The Firebase service-account JSON remains local and ignored by Git.

## 2. Paddle sandbox

1. In Paddle Sandbox, create one product and two recurring prices: monthly and annual. Do not add a trial.
2. Create a sandbox API key with access to transactions, prices, customers, subscriptions, and customer-portal sessions.
3. Create a client-side token for Paddle.js and put it in `.env.staging` as shown above.
4. Add webhook destination:

   ```text
   https://call-relay-staging.zamadshakil.workers.dev/v1/billing/webhooks/paddle
   ```

5. Subscribe at minimum to transaction completed/payment-failed, subscription created/updated/canceled/paused/resumed, and adjustment created/updated events. Refunds and chargebacks arrive as adjustment events.
6. Copy the destination’s endpoint secret. Create ignored `cloud\paddle-keys.txt`:

   ```text
   PADDLE_API_KEY=pdl_sdbx_...
   PADDLE_WEBHOOK_SECRET=pdl_ntfset_...
   ```

7. Replace the staging `PADDLE_MONTHLY_PRICE_ID` and `PADDLE_ANNUAL_PRICE_ID` placeholders in `cloud\wrangler.jsonc` with the two sandbox `pri_...` IDs. The Android APK never contains an amount; the Worker uses Paddle pricing preview for localized totals.

## 3. Prepare Cloudflare staging

From `cloud`:

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm secrets:prepare -- --firebase "..\call-relay-3dec7-firebase-adminsdk-fbsvc-d332308e9a.json" --turn ".\turn-keys.txt" --paddle ".\paddle-keys.txt" --output ".secrets.staging.json" --invite-output ".enrollment-invite.staging.txt" --signal-secret-output ".signal-ticket-secret.staging.txt" --sim-secret-output ".sim-profile-encryption-key.staging.txt"
pnpm exec wrangler d1 migrations apply CALL_RELAY_DB --remote --env staging
pnpm exec wrangler deploy --dry-run --env staging --secrets-file .\.secrets.staging.json
pnpm deploy:staging -- --secrets-file .\.secrets.staging.json
```

If npm argument forwarding does not pass the secrets file on the installed shell, use:

```powershell
pnpm build --mode staging
pnpm exec wrangler deploy --env staging --secrets-file .\.secrets.staging.json
```

## 4. Approve the first Gmail account

Normalize the email to lowercase and insert it only after the owner has been verified:

```powershell
pnpm exec wrangler d1 execute CALL_RELAY_DB --remote --env staging --command "INSERT INTO approved_emails(email,status,created_at,updated_at) VALUES ('owner@gmail.com','approved',unixepoch('now')*1000,unixepoch('now')*1000) ON CONFLICT(email) DO UPDATE SET status='approved',updated_at=excluded.updated_at;"
```

Suspension is the same command with `status='suspended'`. Never use the SIM number as an identity or approval factor.

## 5. Build and install Android

```powershell
cd ..\android
.\scripts\build.ps1
.\scripts\install.ps1
```

Expected consumer flow:

1. Select the approved Google account.
2. Choose Monthly or Annual and complete Paddle Sandbox checkout.
3. Tap **Return to Android app**. The app remains locked until the signed Paddle webhook marks the subscription active.
4. Tap **Set up Call Relay** once, then approve Android’s phone, microphone, notification, default-dialer, and Accessibility screens.
5. A single detected SIM is selected automatically. If Android hides its number, enter it once in E.164 form.
6. On iPhone Safari, open the staging Worker, sign in with the same Google account, tap **Scan Android QR**, and scan.
7. Android verifies the peer proof, confirms pairing, hides the QR, and starts Relay Ready.

## 6. Staging acceptance before cutover

- Verify webhook activation within ten seconds and duplicate/out-of-order webhook safety.
- Kill Android at every onboarding step and confirm it resumes at the first incomplete protected screen.
- Try an unapproved, suspended, unpaid, and different Gmail account.
- Prove QR expiry, replay rejection, same-account enforcement, and explicit old-device replacement.
- Prove direct WebRTC, forced TURN/UDP, TURN/TLS 443, incoming/outgoing SIM calls, and the 15-second media watchdog.
- Confirm phone numbers, Firebase tokens, Paddle secrets, QR challenges, SDP, ICE addresses, and pairing secrets never enter logs.
- Complete at least 20 onboarding/pairing runs and the existing 200-call media pilot before production.

## 7. Production cutover

Create production Paddle product/prices, API key, client token, and webhook independently from sandbox. Update production price IDs and `cloud\.env.production`, prepare production secrets with `--omit-enrollment-invite`, apply migrations `0005` and `0006`, and seed approved accounts. Migration `0006` preserves legacy registration-token pushes while new clients use Firebase Installation IDs. Then:

1. Confirm there are no active calls.
2. Set production `ONBOARDING_V2_ENABLED=true` and `MIN_ANDROID_APP_VERSION=3`, then remove `ENROLLMENT_INVITE` from the production required-secret declaration.
3. Run `pnpm preflight:production`, `pnpm check`, and `pnpm test`.
4. Deploy Worker/PWA, install the release APK, and verify `/v1/devices/enroll` returns `410`.
5. Delete the old production `ENROLLMENT_INVITE` secret after the v2 deployment is healthy. Keep it only in the isolated staging environment while the legacy staging APK is still supported.

Paddle is suitable here only for direct APK distribution. A Google Play build must use Play Billing for paid digital functionality.
