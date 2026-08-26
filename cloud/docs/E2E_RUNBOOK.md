# End-to-end acceptance checklist

Use the full [deployment guide](../../docs/DEPLOYMENT_GUIDE.md).

Before production cutover, staging must prove:

1. single-use/expired tickets and cross-platform HMAC/HKDF vectors;
2. direct WebRTC and forced Cloudflare TURN over UDP and TLS/443;
3. no SIM answer/dial until media connects;
4. incoming/outgoing Listen and Talk paths on a real SIM call;
5. full-duplex double-talk without runaway echo;
6. Wi-Fi/mobile switches recovering within ten seconds;
7. active media loss ending the SIM call after 15 seconds;
8. 19/20 consecutive incoming and 19/20 outgoing successes;
9. a 30-minute call without crash or increasing memory; and
10. a 200-call pilot with at least 99% media establishment before SIM action.

Safari is foreground-only. Native locked-screen iPhone behavior is a later CallKit/PushKit phase.
