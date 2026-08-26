# Security policy

Do not publish credentials, telephone numbers, call metadata, device IDs, pairing QR contents, SDP, ICE addresses, TURN passwords or audio.

If credentials are exposed, revoke/rotate the Cloudflare TURN key/token, Worker secrets, Firebase key and affected pairing. Production values belong only in encrypted Worker secrets or ignored local files.

Signaling uses device P-256 signatures for REST and per-call HKDF/HMAC authentication for WebSocket envelopes. Media uses WebRTC DTLS-SRTP. The Worker, Durable Object and TURN relay must never log SDP, candidates, secrets or audio.

Obtain participant consent and follow applicable carrier, telecom, interception and privacy rules before testing.
