# Call Relay Android

Stock-Android acoustic bridge using raw WebRTC and Cloudflare STUN/TURN. It does not request root, read protected SIM-call PCM, create a PSTN/SIP leg, record audio, or switch media providers.

Implemented behavior:

- Jetpack Compose/Material 3 consumer flow with Credential Manager Google sign-in, Firebase Authentication, Paddle checkout return, resumable DataStore state, and guided protected setup.
- Automatic signed device registration, single-SIM selection where possible, encrypted SIM metadata, five-minute single-use ECDH pairing QR, and automatic Relay Ready startup.
- Default-dialer `InCallService`, one selected SIM and one cellular call, with one browser and one native iPhone peer per Android.
- Relay Ready foreground service and narrow Accessibility Service.
- Signed REST plus one independently authenticated pairing WebSocket per peer. Existing single-pair secrets migrate into the encrypted pairing collection automatically.
- Incoming calls ring both peers. Android waits for the server-selected winner before creating the WebRTC offer or answering Telecom; a rejection affects only that peer until every recipient declines.
- Caller numbers are normalized to E.164 and forwarded when Telecom exposes them. Private or unavailable caller IDs stay absent.
- Android always creates one Unified Plan bidirectional Opus audio transceiver.
- `VOICE_RECOGNITION`, 48/16 kHz input selection, 48 kHz mono output, `MODE_NORMAL`, media/speech attributes, software AEC and disabled hardware AEC/NS.
- Direct ICE first, forced Cloudflare TURN and ICE restart after eight seconds, failure at 20 seconds.
- No SIM answer/dial before media connectivity; active media loss ends the SIM call after 15 seconds.
- Echo-controlled duplex, Listen, Talk, gain/mute/clipping meters, stats and TURN refresh.
- Render-aware gating prevents peer speech from being acoustically returned to that peer. During overlapping speech this intentionally behaves as short voice-switched half duplex.
- The Android speaker and cellular microphone must remain acoustically active; stock Android cannot provide a silent digital carrier-audio bridge.

Build without Android Studio:

```powershell
.\scripts\build.ps1
```

Install on an unlocked USB-debugging phone:

```powershell
.\scripts\install.ps1
```

The debug APK is `app\build\outputs\apk\debug\app-debug.apk`. Place the regenerated ignored Firebase file at `app\google-services.json`; it must contain the Android and Web OAuth clients plus the registered signing-certificate fingerprints.

The Maven artifact is `io.github.webrtc-sdk:android-prefixed:144.7559.09`. Its Java classes use a relocated `livekit.org.webrtc` namespace to avoid libwebrtc class collisions; this is the raw WebRTC binary, not a managed-media client SDK or runtime service.

A physical carrier call is mandatory for qualification. Silence, erased peer playout or unusable double-talk on a handset is a stock-firmware compatibility failure.

The Ready screen can add a second peer without revoking the first. It lists the paired browser/iPhone separately and supports targeted replacement while leaving the other signaling socket active.
