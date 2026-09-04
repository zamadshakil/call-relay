# Call Relay for iPhone

Native SwiftUI/CallKit peer for the Android Call Relay. The deployment target is iOS 17 and the bundle identifier is `dev.zamad.callrelay.ios`.

## Open on the Mac

1. Check the iPhone under **Settings → General → About → iOS Version**. Xcode 16.4 can test supported iOS 18-era devices; if the phone is on iOS 26 or newer, update Xcode and macOS first.
2. In Firebase, add an iOS app with bundle ID `dev.zamad.callrelay.ios`, enable Google sign-in, download `GoogleService-Info.plist`, and place it at `CallRelay/Resources/GoogleService-Info.plist`.
3. Copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig`. Set `GOOGLE_REVERSED_CLIENT_ID` to the plist's `REVERSED_CLIENT_ID` value.
4. Install XcodeGen (`brew install xcodegen`) and run `xcodegen generate` in this directory.
5. Open `CallRelay.xcodeproj`, choose the app target, select your free **Personal Team**, connect the iPhone, and Run.

The WebRTC Swift package is pinned to M137 (`137.0.0`). No APNs, PushKit, or `voip` background mode is requested, so a free Personal Team works. Incoming calls can ring through CallKit only while this app is running and its authenticated WebSocket remains connected. The `audio` background mode keeps an already-active audio call alive while the device is locked. Personal Team builds normally expire after seven days and must be installed again from Xcode.

## Tests

On the Mac, after project generation and package resolution:

```sh
xcodebuild test \
  -project CallRelay.xcodeproj \
  -scheme CallRelay \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

CallKit behavior, Bluetooth routing, lock-screen audio, and real relay audio must be tested on a physical iPhone. The simulator cannot validate the complete audio or system-call path.
