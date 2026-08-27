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

Required encrypted production secrets are `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`, `SIGNAL_TICKET_SECRET`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, and `SIM_PROFILE_ENCRYPTION_KEY`. `ENROLLMENT_INVITE` remains only until legacy staging is disabled. Firebase project, Paddle environment, and monthly/annual price IDs are non-secret Worker variables; the public Firebase/Paddle browser tokens are Vite environment values.

## Consumer APIs

- `POST /v1/auth/session`, `GET /v1/me`
- `GET /v1/billing/plans`, `POST /v1/billing/checkout`, `POST /v1/billing/portal`
- `POST /v1/billing/webhooks/paddle`
- `POST /v1/devices/register`, `PUT /v1/devices/{id}/sim-profile`, `POST /v1/devices/{id}/revoke`
- `POST /v1/pairing-invitations`, `POST /v1/pairing-invitations/{id}/consume`, `GET /v1/pairings/current`

## Media and signaling API

- `POST /v1/pairings/{id}/signal-ticket`
- `GET /v1/pairings/{id}/signal` (WebSocket upgrade)
- `POST /v1/calls/{id}/media-config`
- `POST /v1/calls/{id}/events`

The signaling Durable Object carries call snapshots, SDP offers/answers, ICE candidates and restart requests only. Audio travels directly or through Cloudflare TURN as encrypted DTLS-SRTP. TURN passwords, SDP, candidates, pairing secrets and audio are never written to D1 or logs.

`POST /v1/calls/{id}/token` is permanently disabled with `410 Gone`.

See [ONBOARDING_V2_DEPLOYMENT](../docs/ONBOARDING_V2_DEPLOYMENT.md) for Firebase, Paddle, staging, and cutover.
