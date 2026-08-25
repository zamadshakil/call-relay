# Call Relay Android

Stock-Android acoustic bridge from one normal SIM call to a paired LiveKit browser/iPhone peer. The app does not request root, read protected cellular PCM, add a PSTN leg, or store audio.

## What is implemented

- Default-dialer `InCallService` with incoming, outgoing, answer, end, speaker routing and DTMF control.
- User-started `Relay Ready` microphone foreground service. It is deliberately not restored after process death or reboot.
- Narrow Accessibility Service: no window retrieval and no interaction with other apps.
- One paired peer, one selected SIM and one cellular call while armed.
- E.164-only remote dialing with emergency, short-code, MMI/USSD, call-waiting and conference blocking.
- LiveKit Cloud audio/data room with no SIP, ingress, egress or recording.
- `VOICE_RECOGNITION` capture at 48 kHz, with a 16 kHz initialization fallback. WebRTC resamples its network path to 48 kHz.
- WebRTC software echo cancellation enabled with hardware AEC disabled. LiveKit audio uses media attributes and a no-op audio handler so it does not request audio focus or switch Android to `MODE_IN_COMMUNICATION`.
- Capture gain, clipping protection, WebRTC jitter buffering and remote-track playback gain.
- Full duplex plus Listen, Talk and hold-to-talk diagnostic modes.
- P-256 Android Keystore identity and signed control-plane requests.
- AES-GCM encryption of the pairing secret with a separate non-exportable Android Keystore key.
- Per-call LiveKit E2EE passphrase derived from the pairing secret and call ID using HKDF-SHA256.
- Current Firebase Installation ID registration for FCM remote dial, accept, end, mode, mute and DTMF commands.
- WorkManager-backed retry for push-token synchronization and FCM failure acknowledgements.
- Automatic SIM-call teardown after 15 seconds of missing Internet media.
- Independent call-time microphone level probe; no captured PCM is persisted.

The WebRTC audio device module owns capture/playout in the full-duplex path. This is intentional: its output PCM is the reverse reference for WebRTC AEC. A second app-owned `AudioTrack` would bypass that reverse path and make the exact echo this project needs to remove harder to cancel.

## Command-line build

The installed toolchain is under `E:\Android`. Android Studio and an emulator are not needed.

```powershell
.\scripts\build.ps1
```

The debug APK is written to `app\build\outputs\apk\debug\app-debug.apk`.

To enable FCM, download the Android `google-services.json` from the Firebase project and place it at `app\google-services.json`. Debug builds remain available for local media work without it, but the app refuses to arm Relay Ready and release builds fail their preflight until the file exists.

## Physical-phone gate

1. Install the APK with `scripts\install.ps1` while USB debugging is enabled.
2. Make the app the default dialer and grant its requested permissions.
3. Enable only the `Relay microphone priority` accessibility service.
4. Enroll against the Worker, pair from the browser QR, select the intended SIM and turn Relay Ready on.
5. Start a normal consenting test call and run the independent microphone probe.
6. Compare remote speech, remote silence and simultaneous speech. A changing signal is necessary but does not prove acceptable separation.
7. Test Full duplex first. Listen/Talk/hold-to-talk are diagnostics, not acceptance criteria.

This project cannot certify a handset from a PC build. If Android returns silence during the carrier call, or its telephony processing cancels the LiveKit playback before it reaches the cellular uplink, that handset is incompatible with the stock acoustic method.
