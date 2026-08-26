# Release status

## Implemented

- Cloudflare-only direct/TURN raw WebRTC; no application-level provider fallback.
- Pairing-scoped SQLite Durable Object with WebSocket hibernation, single-use 60-second tickets, role binding and replay checks.
- Cross-platform HKDF/HMAC signaling authentication with a shared golden vector.
- Unique two-hour TURN credentials, 75% refresh, revocation tracking, privacy-safe usage tags and no stored passwords.
- Native browser WebRTC, foreground signaling, direct/TURN route and quality statistics.
- Android raw WebRTC audio, direct-to-relay ICE restart, network-change recovery, 20-second setup gate and 15-second active watchdog.
- D1 media state/summary fields, 30-second Android heartbeat, 90-second active timeout and 24-hour purge.
- The old participant-token endpoint returns `410 Gone`.

## Verified locally on 2026-08-27

- Worker/D1 integration tests and TypeScript production browser build.
- Android unit tests, cross-platform crypto vector, lint, debug APK assembly and instrumentation-test APK compilation.
- No managed-media client dependency in Android, browser package manifest or browser bundle.

## Still required

- A separate staging TURN key and the six staging Worker secrets. The staging D1 database, Queues and migrations already exist; the first Worker deployment is intentionally blocked until its secrets file is available.
- Real Android/browser direct, forced UDP TURN and TLS/443 tests.
- Incoming/outgoing acoustic qualification, network switching, 200-call pilot and 30-minute stability gate.
- Native iPhone client after a Mac and paid Apple Developer account are available.

The existing production deployment is the previous build until the isolated staging gates pass.
