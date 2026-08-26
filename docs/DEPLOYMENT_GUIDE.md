# Cloudflare-only deployment guide

The existing production Worker stays online while this replacement is validated in an isolated staging environment. Do not deploy the migration directly to production.

## 1. Accounts and local checks

Required: Cloudflare Workers/D1/Queues/Realtime TURN, Firebase FCM, a physical API 29+ Android phone, and a foreground browser peer.

```powershell
cd cloud
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm check
cd ..\android
.\scripts\build.ps1
```

Android Studio and an emulator are not required.

## 2. Create isolated staging resources

From `cloud`:

```powershell
pnpm exec wrangler login
pnpm exec wrangler whoami
pnpm exec wrangler d1 create call-relay-staging
pnpm exec wrangler queues create call-relay-staging-push
pnpm exec wrangler queues create call-relay-staging-push-dlq
```

Create a separate TURN key named `call-relay-staging` in Cloudflare Realtime. Save its key ID and scoped API token outside Git. Configure an environment-specific Worker name, D1 UUID, Queue names and FCM project. The Durable Object namespace is created from the checked-in `PAIRING_SIGNAL` binding/SQLite class during deployment.

Apply migrations and verify `0004_cloudflare_webrtc.sql`:

```powershell
pnpm exec wrangler d1 migrations list CALL_RELAY_DB --remote --env staging
pnpm exec wrangler d1 migrations apply CALL_RELAY_DB --remote --env staging
pnpm exec wrangler d1 migrations list CALL_RELAY_DB --remote --env staging
```

## 3. Configure secrets

Create an ignored `turn-keys.txt` containing only:

```text
CF_TURN_KEY_ID=...
CF_TURN_API_TOKEN=...
```

Prepare and validate all six Worker secrets without printing them:

```powershell
pnpm secrets:prepare -- --firebase "C:\secure\firebase-service-account.json" --turn "C:\secure\turn-keys.txt" --output ".secrets.staging.json" --invite-output ".enrollment-invite.staging.txt" --signal-secret-output ".signal-ticket-secret.staging.txt"
pnpm providers:validate -- --firebase "C:\secure\firebase-service-account.json" --turn "C:\secure\turn-keys.txt"
```

`SIGNAL_TICKET_SECRET` must be at least 32 random bytes. TURN credentials are generated server-side, expire after two hours, refresh at 75%, and are revoked after calls. Passwords never enter D1.

## 4. Deploy staging

```powershell
pnpm types
pnpm check
pnpm test
pnpm exec wrangler deploy --dry-run --env staging --secrets-file .\.secrets.staging.json
pnpm build
pnpm exec wrangler deploy --env staging --secrets-file .\.secrets.staging.json
pnpm exec wrangler secret list --env staging
```

Verify `/health` returns `mediaTransport: "webrtc_p2p"`, the browser shows authenticated signaling, and the removed `/token` endpoint returns `410`.

## 5. Install the staging APK

Debug builds default to `https://call-relay-staging.zamadshakil.workers.dev`; release builds default to production. Switching environments clears the device enrollment and pairing secret while preserving SIM/audio preferences, so install the debug build and enroll/pair it again in staging. The Android UI can still override the URL for a custom HTTPS environment. Then:

```powershell
cd ..\android
.\scripts\build.ps1
.\scripts\install.ps1
```

On Android: choose Call Relay as default dialer, grant phone/microphone/notification permissions, enable only `Relay microphone priority`, enroll, scan the browser pairing QR, select one SIM, and turn Relay Ready on.

The browser must show `Connected and authenticated` plus `Android online` before testing.

## 6. Staging media gates

Use consenting non-emergency calls.

- Confirm a direct route first (`host` or `srflx`).
- Force `iceTransportPolicy: relay` and prove TURN/UDP.
- Block UDP and prove TURN/TLS on 443.
- Switch Wi-Fi to mobile and back while active; require recovery within ten seconds.
- Test incoming: browser acceptance prepares media; Android answers only after connected.
- Test outgoing: Android places the SIM call only after connected.
- Prove Listen, Talk, Full duplex, 15-second watchdog, 30-minute stability and TURN refresh.

Complete the 200-call acceptance matrix in `cloud/docs/E2E_RUNBOOK.md`. Code tests cannot prove stock-Android acoustic compatibility.

## 7. Production cutover

Only after staging passes:

1. Apply the additive D1 migration to production.
2. Upload `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, and `SIGNAL_TICKET_SECRET` alongside existing Firebase/enrollment secrets.
3. Install the new APK and validate it against production TURN before a carrier call.
4. Confirm no active call sessions.
5. Deploy Worker/browser and enforce Android version 2+.
6. Confirm `/token` is `410`, WebSocket signaling works, and call setup succeeds.
7. Delete obsolete managed-media secrets from the Worker.
8. Scan APK, JavaScript bundle, dependency lockfiles and network logs for obsolete provider dependencies/connections.

There is no media-provider rollback in the application. Production faults are fixed on the Cloudflare/raw-WebRTC path. A Cloudflare outage prevents new calls and must surface as an explicit service-unavailable failure before SIM answer/dial.

## 8. Native iPhone phase

After Android/browser WebRTC passes, build Swift/SwiftUI with CallKit, PushKit/APNs, AVAudioSession, raw WebRTC and Keychain-backed identity/pairing keys. Safari remains foreground-only and cannot satisfy locked-screen production behavior.
