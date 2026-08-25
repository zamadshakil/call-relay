# Architecture and first-principles constraints

## The invariant

Android Telecom owns the protected digital audio path of a normal SIM call. A stock third-party app cannot obtain that downlink PCM or inject arbitrary uplink PCM. LiveKit, WebRTC, Accessibility, default-dialer status, and microphone permissions do not remove this boundary.

This implementation uses the only software-only path available without root, a modified OS, carrier/SIP infrastructure, or bridge hardware: acoustic coupling through the Android handset's speaker and microphone.

## Components

1. **Android call endpoint** keeps ownership of the SIM call, reports Telecom state, validates remote-dial requests, forces speaker routing, and publishes microphone audio to LiveKit.
2. **Cloudflare control plane** authenticates paired devices, enforces the call state machine, issues short-lived LiveKit tokens, delivers Android commands through FCM, and expires metadata.
3. **LiveKit media plane** carries peer audio and data. It is not a PSTN or SIP leg and is configured without recording, ingress, or egress.
4. **Browser peer** is the first remote client. It signs requests, joins the room, derives per-call E2EE material, and exposes call and diagnostic controls.
5. **Future iPhone peer** replaces the browser with CallKit, PushKit, AVAudioSession, Keychain, and LiveKit Swift when Apple build infrastructure is available.

## Incoming call flow

1. Android Telecom reports a ringing SIM call.
2. Android creates an authenticated session in the Worker; the phone is not answered yet.
3. The browser discovers the ringing session and accepts or rejects it.
4. Both peers receive scoped LiveKit credentials and derive the same per-call E2EE passphrase from the pairing secret and call ID.
5. Android answers only after acceptance, moves the SIM call to speaker, and starts the media bridge.
6. If Internet media remains unavailable for more than 15 seconds, Android ends the SIM call to prevent an unattended open line.

## Outgoing call flow

1. The peer submits one normalized E.164 number.
2. The Worker authenticates the request, creates a session, and sends an FCM command to the paired Android device.
3. Android revalidates the destination and rejects emergency numbers, short codes, MMI/USSD, an existing call, and unsupported multi-call conditions.
4. Android places the call through the user-selected SIM.
5. Relay media starts only after Telecom reports the call active.

## Audio modes

- **Full duplex** captures Android microphone audio and plays remote audio concurrently. WebRTC software AEC uses remote playout as its reverse reference.
- **Listen** publishes Android capture while muting remote playback.
- **Talk** plays remote audio while muting Android relay publication.
- **Hold-to-talk** switches between the two diagnostic directions.

Listen and Talk are diagnostic evidence, not product acceptance. A handset passes only when repeated full-duplex physical-call tests meet intelligibility, echo, reliability, and duration requirements.

## Trust boundaries

- Each device has a P-256 signing identity. Requests include a timestamp, nonce, body digest, and signature.
- Pairing secrets are exchanged by QR and encrypted at rest with non-exportable platform keys.
- Per-call E2EE passphrases are derived with HKDF-SHA256 from the pairing secret and call ID.
- Worker secrets, Firebase credentials, LiveKit credentials, generated builds, and local databases are excluded from Git.
- The Worker controls authorization and state; it never receives relay PCM.

## Irreducible compatibility gate

A desktop build, emulator, unit test, or WebRTC loopback cannot prove the acoustic bridge. The target Android model must demonstrate all of the following during a real, consenting carrier call:

- microphone capture remains non-silent and contains intelligible caller speech;
- remote LiveKit playout remains audible to the cellular uplink;
- playback does not steal Telecom audio focus or terminate the SIM call;
- echo cancellation does not erase the wanted cellular downlink;
- full duplex stays stable during simultaneous speech and a 30-minute call.

Failure at that gate means the tested stock firmware is incompatible. Application code cannot legitimately bypass the protected-call boundary.
