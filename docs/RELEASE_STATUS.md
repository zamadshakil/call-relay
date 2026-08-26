# Release status

## Implemented in this repository

- Android default-dialer and `InCallService` call lifecycle.
- Relay Ready foreground service and narrowly scoped Accessibility Service.
- SIM selection, one-call/one-peer enforcement, destination validation, speaker routing, DTMF, and process-death-safe behavior.
- LiveKit audio with full-duplex, Listen, Talk, and hold-to-talk modes.
- P-256 signed requests, replay protection inputs, encrypted pairing material, and per-call E2EE derivation.
- FCM device registration, command handling, retries, and failure acknowledgements.
- Worker call-state API, D1 schema and migrations, cleanup, Queue consumer, browser pairing and call console.
- Automated Worker integration tests, TypeScript checks, Android unit tests, lint, and build gates.
- Production preflight that rejects placeholder Cloudflare, LiveKit, Firebase, and required-secret configuration.

## Verified without external production accounts

- Cloud TypeScript compilation and production web build.
- Isolated Worker/D1 API test suite.
- Android unit tests, lint, and debug APK assembly.
- Secret and generated-artifact exclusion from version control.

## External gates still required

- Create and configure the production Cloudflare D1 database, Queues, encrypted Worker secrets, and Worker deployment.
- Create a LiveKit Cloud project and install its credentials as Worker secrets.
- Create a Firebase project, add `google-services.json` locally, and install the service-account credentials as Worker secrets.
- Enroll and pair a real browser and Android handset.
- Run the physical carrier-call compatibility matrix in `cloud/docs/E2E_RUNBOOK.md`.
- Build the native iPhone peer later with a Mac and paid Apple Developer account.

The system is not end-to-end certified until the account gates and physical-handset tests pass. That qualification cannot be replaced by an emulator.
