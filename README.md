# Stock Android SIM Call Relay

An experimental, invite-only system that keeps a normal carrier call on a stock Android phone and relays it acoustically over LiveKit to a paired browser or future iPhone app.

The repository is intentionally honest about the platform boundary: a normal Android app cannot read or inject protected cellular-call PCM. The Android handset therefore remains on speakerphone, its microphone captures the caller acoustically, and peer audio is played through the handset speaker. Whether full duplex works is handset- and firmware-dependent and must be proven on a physical phone.

## Repository layout

- `android/` — Kotlin Android dialer, `InCallService`, relay-ready foreground service, signed control plane, LiveKit media bridge, and diagnostic modes.
- `cloud/` — TypeScript Cloudflare Worker, D1 migrations, Queue handling, browser peer, API tests, and deployment preflight.
- `docs/ARCHITECTURE.md` — trust boundaries, call flows, failure behavior, and non-negotiable limitations.
- `docs/DEPLOYMENT_GUIDE.md` — complete LiveKit, Firebase, Cloudflare, Android, pairing and physical-call activation procedure.
- `docs/RELEASE_STATUS.md` — what is implemented, what is verified, and what still requires external accounts or a physical handset.
- `scripts/verify.ps1` — one command for the repository's repeatable local checks.

## Quick start

### Cloud control plane and browser peer

```powershell
cd cloud
Copy-Item .dev.vars.example .dev.vars
pnpm install --frozen-lockfile
pnpm db:local
pnpm dev
```

Replace every placeholder in `.dev.vars`; never commit that file. See `docs/DEPLOYMENT_GUIDE.md` for production setup.

### Android app

The project builds from the command line and does not require Android Studio:

```powershell
cd android
.\scripts\build.ps1
```

For push notifications, place a Firebase Android configuration at `android/app/google-services.json`. It is intentionally ignored by Git.

## Verification

```powershell
.\scripts\verify.ps1
```

Continuous integration performs the equivalent TypeScript, Worker test, Android unit-test, lint, and debug-build gates on every push and pull request.

## Safety and privacy

- Do not use this system for emergency numbers, short codes, MMI/USSD, conferences, or call waiting.
- Obtain consent from every call participant and follow local recording, interception, telecom, and privacy laws.
- The Android speaker is audible and the microphone captures the surrounding room.
- No audio is intentionally stored by this system; call metadata is designed to expire after 24 hours.
- This prototype is not a safety-critical or emergency-calling product.

This repository has no open-source license. All rights are reserved unless the owner adds one later.
