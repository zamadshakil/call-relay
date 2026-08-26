# Architecture and first-principles constraints

## Invariant

Android Telecom owns normal SIM-call digital audio. Permissions, Accessibility, default-dialer status and WebRTC do not expose that PCM to a stock app. This system therefore uses acoustic coupling through Android's speaker and microphone.

## Components

1. Android owns the SIM call, validates dialing, gates answer/dial on WebRTC connectivity, and is always the SDP offerer.
2. A Cloudflare Worker authenticates signed REST calls, brokers two-hour TURN credentials, writes authoritative call state to D1, and wakes Android through FCM.
3. One SQLite Durable Object per pairing provides hibernating WebSocket signaling. It never carries audio.
4. The browser uses native `RTCPeerConnection`, DTLS-SRTP audio, browser AEC, and signed/HMAC-authenticated signaling.
5. The future iPhone app will use CallKit, PushKit, AVAudioSession, Keychain and raw WebRTC.

## Media sequence

Both clients obtain unique Cloudflare credentials. ICE starts with policy `all`; host/server-reflexive direct routes are preferred naturally. After eight seconds Android and the peer force `relay` and restart ICE. Setup fails at 20 seconds. An incoming SIM call is not answered, and an outgoing SIM call is not placed, until media is connected. Active media loss beyond 15 seconds ends the SIM call.

WebRTC DTLS-SRTP encrypts audio end-to-end. TURN forwards encrypted packets. SDP and ICE are integrity-authenticated with a per-call key:

`HKDF-SHA256(pairingSecret, salt=callId, info="call-relay/signaling/v1")`

Each envelope binds protocol, call, sender, role, socket session, monotonic sequence, timestamp, type and payload with HMAC-SHA256. Cloudflare may route signaling but cannot undetectably replace SDP fingerprints or candidates.

## Acoustic modes

- Full duplex: Android capture and peer playout enabled.
- Listen: Android capture enabled; peer-to-Android playout muted.
- Talk: Android capture muted; peer-to-Android playout enabled.

The raw WebRTC audio device uses `VOICE_RECOGNITION`, 48 kHz output, a 48/16 kHz input fallback, media/speech attributes, `MODE_NORMAL`, software AEC, and no app-owned Telecom focus. Hardware AEC/NS are disabled. Capture/render processors apply gain, clipping protection, mute and meters while WebRTC receives the real reverse playout reference.

No build or emulator can certify the acoustic path. A target handset must prove caller capture, peer-to-cellular uplink, double-talk, network recovery and 30-minute stability on a real SIM call.
