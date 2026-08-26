# Call Relay Cloud

Cloudflare control plane, hibernating signaling and native-WebRTC browser peer for the stock-Android acoustic relay.

## Local

```powershell
Copy-Item .dev.vars.example .dev.vars
pnpm install --frozen-lockfile
pnpm db:local
pnpm test
pnpm dev
```

Required encrypted production secrets are `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `SIGNAL_TICKET_SECRET`, `ENROLLMENT_INVITE`, `FCM_CLIENT_EMAIL`, and `FCM_PRIVATE_KEY`. `FCM_PROJECT_ID` is a non-secret Worker variable.

## Media and signaling API

- `POST /v1/pairings/{id}/signal-ticket`
- `GET /v1/pairings/{id}/signal` (WebSocket upgrade)
- `POST /v1/calls/{id}/media-config`
- `POST /v1/calls/{id}/events`

The signaling Durable Object carries call snapshots, SDP offers/answers, ICE candidates and restart requests only. Audio travels directly or through Cloudflare TURN as encrypted DTLS-SRTP. TURN passwords, SDP, candidates, pairing secrets and audio are never written to D1 or logs.

`POST /v1/calls/{id}/token` is permanently disabled with `410 Gone`.

See [DEPLOYMENT_GUIDE](../docs/DEPLOYMENT_GUIDE.md) for staging and cutover.
