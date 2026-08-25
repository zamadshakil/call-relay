# End-to-end activation runbook

The code is locally buildable and tested, but the real relay cannot be activated with placeholder cloud values or without a physical Android phone. Complete these gates in order.

## 1. Provision external services

- Cloudflare: log in with Wrangler, create D1 database `call-relay`, Queue `call-relay-push`, and Queue `call-relay-push-dlq`.
- LiveKit Cloud: create a project and keep its secure WebSocket URL, API key and API secret.
- Firebase: create an Android app with package `dev.zamad.callrelay`, enable Cloud Messaging, download `google-services.json`, and create a service account permitted to send FCM HTTP v1 messages.

Put `google-services.json` at `call-relay-android/app/google-services.json`. Never commit it or the service-account private key.

## 2. Configure and deploy the Worker

1. Replace the placeholder D1 ID, LiveKit URL and Firebase project ID in `wrangler.jsonc`.
2. Bind the five values listed in `SECRETS_STORE.md` from Cloudflare Secrets Store.
3. Run `pnpm preflight:production`; it must pass without exceptions.
4. Apply all D1 migrations remotely with `pnpm exec wrangler d1 migrations apply CALL_RELAY_DB --remote`.
5. Run `pnpm deploy` and record the resulting HTTPS Worker URL.

## 3. Build and configure Android

1. Run `call-relay-android/scripts/build.ps1`.
2. Connect a physical API 29+ Android phone with USB debugging and run `scripts/install.ps1`.
3. Open Call Relay, grant all requested permissions, make it the default dialer, and enable only its narrowly scoped accessibility service.
4. Enter the deployed Worker URL and a long random enrollment invite, then enroll.

## 4. Pair the browser peer

1. Open the Worker URL in the peer browser, preferably on the iPhone for the real test.
2. Enroll the browser with the same invite.
3. Paste the Android device ID, create the pairing, and immediately scan the displayed QR on Android.
4. Confirm that Android shows the pairing as confirmed, select the intended SIM, and enable Relay Ready.
5. Rotate or disable the enrollment invite after both devices are enrolled.

The browser must remain open for this first implementation. A native background iPhone/CallKit client still requires a Mac and Apple Developer account.

## 5. Acceptance sequence

Use a consenting, non-emergency test number.

1. Run the independent microphone probe during a cellular call. Stop if the samples remain silent.
2. Complete one incoming and one outgoing call in Listen mode.
3. Complete the same two paths in Talk mode.
4. Test full duplex with alternating speech, silence, and simultaneous speech; reject the handset if echo remains operationally unusable.
5. Disconnect Wi-Fi and confirm the Android ends the SIM call after 15 seconds without a paired media participant.
6. Run 20 consecutive incoming/outgoing attempts and require at least 19 successes.
7. Keep one full-duplex call active for 30 minutes and confirm no crash, runaway echo or broken reconnection.

Passing code tests does not waive these physical checks. Stock Android does not expose protected carrier-call PCM to this app; the handset's acoustic capture and telephony processing decide compatibility.
