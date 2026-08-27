# Stock Android SIM Call Relay

An experimental, approved-account acoustic relay from a normal stock-Android SIM call to a paired iPhone browser or future native iPhone app.

Media uses raw WebRTC: direct peer-to-peer when ICE can establish it, otherwise encrypted Cloudflare TURN. A pairing-scoped Cloudflare Durable Object carries signaling only. There is no SIP/PSTN bridge, media server, recording, provider fallback, root requirement, modified OS, or extra hardware.

The platform limit remains: a stock third-party Android app cannot read or inject protected cellular-call PCM. The Android stays on speakerphone, its microphone captures caller audio acoustically, and peer audio plays through that speaker. Full-duplex quality is handset-dependent and must be proven on a physical SIM call.

## Layout

- `android/` — Compose consumer onboarding, Google/Firebase sign-in, guided protected permissions, SIM discovery, secure QR pairing, Kotlin default dialer, Telecom integration, and raw libwebrtc media.
- `cloud/` — Gmail approval and Paddle entitlement, mobile PWA, TypeScript Worker, D1, Queues, SQLite Durable Object signaling, and TURN credential broker.
- `docs/DEPLOYMENT_GUIDE.md` — staging/production deployment and phone-test procedure.
- `docs/ONBOARDING_V2_DEPLOYMENT.md` — exact Firebase, Paddle, account-approval, staging, and consumer-onboarding deployment.
- `scripts/verify.ps1` — repeatable cloud and Android checks.

## Verify

```powershell
.\scripts\verify.ps1
```

Android Studio and an emulator are not required; the repository uses its command-line JDK/SDK toolchain.

The app cannot silently grant Android permissions, make itself the default dialer, or enable Accessibility. It automatically opens and advances through those protected screens after one setup action, while Android requires the user to confirm each system dialog.

Do not use this prototype for emergencies. Obtain participant consent and comply with applicable telecom, interception and privacy laws. Audio is not intentionally stored; call metadata is purged after 24 hours.
