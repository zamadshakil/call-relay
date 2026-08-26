# Call Relay Android

Stock-Android acoustic bridge using raw WebRTC and Cloudflare STUN/TURN. It does not request root, read protected SIM-call PCM, create a PSTN/SIP leg, record audio, or switch media providers.

Implemented behavior:

- Default-dialer `InCallService`, one selected SIM, one call and one paired peer.
- Relay Ready foreground service and narrow Accessibility Service.
- Signed REST plus authenticated pairing WebSocket signaling.
- Android always creates one Unified Plan bidirectional Opus audio transceiver.
- `VOICE_RECOGNITION`, 48/16 kHz input selection, 48 kHz mono output, `MODE_NORMAL`, media/speech attributes, software AEC and disabled hardware AEC/NS.
- Direct ICE first, forced Cloudflare TURN and ICE restart after eight seconds, failure at 20 seconds.
- No SIM answer/dial before media connectivity; active media loss ends the SIM call after 15 seconds.
- Full duplex, Listen, Talk, gain/mute/clipping meters, stats and TURN refresh.

Build without Android Studio:

```powershell
.\scripts\build.ps1
```

Install on an unlocked USB-debugging phone:

```powershell
.\scripts\install.ps1
```

The debug APK is `app\build\outputs\apk\debug\app-debug.apk`. Place the ignored Firebase file at `app\google-services.json` before Relay Ready can arm.

The Maven artifact is `io.github.webrtc-sdk:android-prefixed:144.7559.09`. Its Java classes use a relocated `livekit.org.webrtc` namespace to avoid libwebrtc class collisions; this is the raw WebRTC binary, not a managed-media client SDK or runtime service.

A physical carrier call is mandatory for qualification. Silence, erased peer playout or unusable double-talk on a handset is a stock-firmware compatibility failure.
