# End-to-end activation runbook

The authoritative command-by-command instructions are in `../../docs/DEPLOYMENT_GUIDE.md`. This file remains as the compact acceptance checklist.

The production Worker and providers were activated on 2026-08-26. The real relay still requires a physical Android phone. Complete the remaining gates in order.

Current production control plane: `https://call-relay.zamadshakil.workers.dev`.

## 1. Provision external services

- Cloudflare: complete. D1 database `calling-system`, Queue `call-relay-push`, and Queue `call-relay-push-dlq` are provisioned.
- LiveKit Cloud: complete. The API credentials passed an authenticated RoomService request.
- Firebase: complete. Android app `dev.zamad.callrelay`, local `google-services.json`, and messaging-scope service-account OAuth are verified.

Put `google-services.json` at `android/app/google-services.json`. Never commit it or the service-account private key.

## 2. Configure and deploy the Worker

This stage is complete. For future code-only deployments, run `pnpm deploy`; Wrangler preserves the installed secrets. Re-run remote migration listing whenever a migration is added.

## 3. Build and configure Android

1. Run `android/scripts/build.ps1`.
2. Connect a physical API 29+ Android phone with USB debugging and run `scripts/install.ps1`.
3. Open Call Relay, grant all requested permissions, make it the default dialer, and enable only its narrowly scoped accessibility service.
4. The deployed Worker URL is prefilled. Read the invite from the ignored local file `cloud/.enrollment-invite.txt`, then enroll.

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
