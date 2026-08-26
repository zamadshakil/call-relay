# Call Relay Cloud

Private Cloudflare Worker and browser peer for the stock-Android acoustic SIM relay.

## Local run

1. Copy `.dev.vars.example` to `.dev.vars` and replace every placeholder.
2. Run `pnpm install`.
3. Run `pnpm db:local`.
4. Run `pnpm dev`.
5. Run `pnpm test` for the isolated Workers/D1 control-plane suite.

The production deployment also needs a real D1 ID in `wrangler.jsonc`, provisioned Queues, the LiveKit/Firebase variables, and encrypted Worker secrets for `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ENROLLMENT_INVITE`, `FCM_CLIENT_EMAIL`, and `FCM_PRIVATE_KEY`.

Audio travels only through the LiveKit room. This Worker stores devices, pairings, call state, and events; its scheduled cleanup deletes call metadata older than 24 hours.

`pnpm deploy` runs a production preflight first. It deliberately refuses to deploy while the D1 ID, LiveKit URL, Firebase project or required-secret declarations are placeholders. Wrangler then verifies that the declared secrets exist on the Worker.

## Implemented API

- `POST /v1/devices/enroll`
- `POST /v1/devices/push-token`
- `POST /v1/pairings`
- `POST /v1/pairings/{id}/confirm`
- `POST /v1/calls/incoming`
- `POST /v1/calls/outgoing`
- `GET /v1/calls/current` (browser polling fallback)
- `GET /v1/calls/{id}`
- `POST /v1/calls/{id}/token`
- `POST /v1/calls/{id}/events`

Except for invite-protected enrollment, requests use a P-256 signature, timestamp and one-use nonce. LiveKit JWTs expire after ten minutes. Browser signing and pairing keys are non-exportable `CryptoKey` objects in IndexedDB; Android signing and pairing-encryption keys are non-exportable Android Keystore keys.

The browser peer supports incoming-session polling, outgoing E.164 requests, accept/end, full-duplex/listen/talk, mute, DTMF, LiveKit microphone/speaker audio, per-call E2EE and Android pairing QR generation. Android push delivery uses the current FCM Firebase Installation ID target.

See `docs/SECRETS.md` before production deployment.
See `../docs/DEPLOYMENT_GUIDE.md` for the complete account, deployment and physical-phone sequence.
