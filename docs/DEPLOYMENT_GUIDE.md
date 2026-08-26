# End-to-end deployment guide

This runbook activates the existing prototype in the correct dependency order. It covers the managed LiveKit media service, Firebase push delivery, Cloudflare infrastructure and Worker/browser console, Android installation, pairing, and the first physical carrier-call qualification.

The iPhone side is currently the hosted browser peer. There is no native iPhone application to deploy yet.

## 0. Define the first acceptance milestone

The first milestone is one consenting, non-emergency carrier call in which:

1. the SIM call remains on the Android phone;
2. the iPhone browser joins the matching LiveKit room;
3. caller audio reaches the iPhone in Listen mode;
4. iPhone speech reaches the cellular caller in Talk mode; and
5. both directions remain usable in Full duplex.

Do not start native iPhone development until the target Android handset passes this physical compatibility gate.

## 1. Prepare accounts and workstation

Create or obtain access to:

- a Cloudflare account with Workers, D1 and Queues access;
- a LiveKit Cloud account;
- a Firebase/Google Cloud project where you can create an Android app and service account;
- a physical Android API 29+ handset with a working SIM, Internet, Google Play services and USB debugging;
- the iPhone that will run the hosted browser peer; and
- a consenting, non-emergency test number.

Install Git, Node.js 22+, Corepack, JDK 17, Android SDK 36 and Android platform-tools/ADB. Android Studio and an emulator are not required.

Clone and verify the repository:

```powershell
git clone https://github.com/zamadshakil/stock-android-call-relay.git
cd stock-android-call-relay

cd cloud
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test
cd ..
```

Expected result: TypeScript and the browser production build pass, followed by seven Worker/D1 tests.

## 2. Provision LiveKit Cloud

1. Sign in at [LiveKit Cloud](https://cloud.livekit.io/).
2. Create a project dedicated to this relay, for example `call-relay-production`.
3. Open the project settings and copy the **Project URL** beginning with `wss://`.
4. Open **Settings → Keys**, create a dedicated API key, and securely save both its API key and API secret.
5. Do not put the key or secret into browser code, Android resources or Git.
6. Do not enable LiveKit's development token server for production. This repository's authenticated Worker issues scoped, short-lived participant tokens.
7. Do not configure SIP, recording, ingress or egress; this architecture uses LiveKit rooms for app audio/data only.

Save these three values in a password manager for the Cloudflare steps:

- `LIVEKIT_URL` — non-secret `wss://…livekit.cloud` project URL;
- `LIVEKIT_API_KEY` — secret;
- `LIVEKIT_API_SECRET` — secret.

Reference: [LiveKit project and CLI credentials](https://docs.livekit.io/reference/developer-tools/livekit-cli/projects/).

## 3. Provision Firebase Cloud Messaging

1. Sign in at the [Firebase console](https://console.firebase.google.com/) and create a dedicated project.
2. Record the immutable Firebase **Project ID**; this becomes `FCM_PROJECT_ID`.
3. Add an Android app with the exact package name `dev.zamad.callrelay`.
4. Download `google-services.json` and place it at:

   `android/app/google-services.json`

   Confirm that the filename has no suffix such as `(1)`. Git ignores this file.
5. In Firebase project settings, open **Cloud Messaging** and confirm that the FCM HTTP v1 API is enabled.
6. In Google Cloud IAM, create a dedicated service account for this Worker and grant the minimum role needed to send messages: **Firebase Cloud Messaging API Admin**.
7. Create one JSON key for that service account and download it to a secure location outside the repository.
8. Record its `client_email` and `private_key`. Never paste the entire service-account JSON into the repository or chat.

The Android phone must have Google Play services for this implementation's FCM registration path.

References: [add Firebase to Android](https://firebase.google.com/docs/android/setup), [FCM Android setup](https://firebase.google.com/docs/cloud-messaging/android/get-started), and [FCM HTTP v1 authorization](https://firebase.google.com/docs/cloud-messaging/send/v1-api).

## 4. Provision Cloudflare infrastructure

Run these commands from the repository's `cloud` directory:

```powershell
cd cloud
pnpm exec wrangler --version
pnpm exec wrangler login
pnpm exec wrangler whoami
```

The repository pins a compatible Wrangler release. Complete the browser authorization and verify the intended Cloudflare account.

### 4.1 Create D1

```powershell
pnpm exec wrangler d1 create call-relay
```

Copy the returned database UUID. In `cloud/wrangler.jsonc`, replace:

`00000000-0000-0000-0000-000000000000`

with the real UUID while preserving:

- binding: `CALL_RELAY_DB`
- database name: `call-relay`
- migrations directory: `migrations`

Reference: [Wrangler D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/).

### 4.2 Create the push and dead-letter queues

```powershell
pnpm exec wrangler queues create call-relay-push
pnpm exec wrangler queues create call-relay-push-dlq
```

The checked-in Worker configuration already binds `call-relay-push` as `PUSH_QUEUE`, registers the Worker as its consumer, retries failed messages five times, and sends exhausted messages to `call-relay-push-dlq`.

References: [configure Queues](https://developers.cloudflare.com/queues/configuration/configure-queues/) and [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).

### 4.3 Set non-secret production variables

Edit `cloud/wrangler.jsonc`:

- replace `wss://replace-me.livekit.cloud` with the LiveKit Project URL;
- replace `FCM_PROJECT_ID: "replace-me"` with the Firebase Project ID.

Keep the `wss://` scheme. Do not put API keys or Firebase private keys in `vars`.

Regenerate types and recheck the project:

```powershell
pnpm types
pnpm check
```

### 4.4 Set encrypted Worker secrets

Choose a random enrollment invite of at least 32 characters, store it in a password manager, and use the same value only while enrolling the two devices.

For the first deployment, upload all required secrets atomically with Wrangler's `--secrets-file` option. This avoids creating partially configured Worker versions. Create the ignored file from protected prompts and the Firebase JSON:

```powershell
$firebaseCredentialPath = "C:\secure\call-relay-firebase-service-account.json"
$firebaseCredential = Get-Content -Raw -LiteralPath $firebaseCredentialPath | ConvertFrom-Json
$liveKitApiKeySecure = Read-Host "LiveKit API key" -AsSecureString
$liveKitApiSecretSecure = Read-Host "LiveKit API secret" -AsSecureString
$enrollmentInviteSecure = Read-Host "Enrollment invite" -AsSecureString
$productionSecrets = @{
    LIVEKIT_API_KEY = [System.Net.NetworkCredential]::new("", $liveKitApiKeySecure).Password
    LIVEKIT_API_SECRET = [System.Net.NetworkCredential]::new("", $liveKitApiSecretSecure).Password
    ENROLLMENT_INVITE = [System.Net.NetworkCredential]::new("", $enrollmentInviteSecure).Password
    FCM_CLIENT_EMAIL = $firebaseCredential.client_email
    FCM_PRIVATE_KEY = $firebaseCredential.private_key
}
$secretPayloadPath = Join-Path (Get-Location) ".secrets.production.json"
[System.IO.File]::WriteAllText($secretPayloadPath, ($productionSecrets | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
Remove-Variable firebaseCredential
Remove-Variable liveKitApiKeySecure, liveKitApiSecretSecure, enrollmentInviteSecure, productionSecrets, secretPayloadPath
```

Do not open, print or commit `.secrets.production.json`. It is explicitly ignored by Git. Section 5 uploads it with the first deployment; delete that exact local file immediately after the deployment is confirmed.

After the first deployment, use Wrangler's protected prompt to rotate a single ordinary value. For the multiline Firebase key, pipe it from the secured service-account JSON instead of putting it in shell history:

```powershell
pnpm exec wrangler secret put LIVEKIT_API_KEY
$firebaseCredential = Get-Content -Raw -LiteralPath $firebaseCredentialPath | ConvertFrom-Json
$firebaseCredential.private_key | pnpm exec wrangler secret put FCM_PRIVATE_KEY
Remove-Variable firebaseCredential
```

Cloudflare hides the values. Do not use command-line `--value` flags because they leave secrets in shell history.

Per-Worker secrets are required here because their 5 KB value limit accepts the Firebase private key. Cloudflare Secrets Store currently limits each secret to 1024 bytes, which is commonly too small for that key.

References: [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## 5. Initialize D1 and deploy the Worker/browser console

Run the repository preflight:

```powershell
pnpm preflight:production
```

Do not continue until it prints `Production configuration preflight passed.`

Apply all migrations to the production D1 database:

```powershell
pnpm exec wrangler d1 migrations list CALL_RELAY_DB --remote
pnpm exec wrangler d1 migrations apply CALL_RELAY_DB --remote
pnpm exec wrangler d1 migrations list CALL_RELAY_DB --remote
```

Validate the deployment package, build the browser client, and perform the first deployment with all five secrets atomically:

```powershell
pnpm exec wrangler deploy --dry-run
pnpm build
pnpm exec wrangler deploy --secrets-file .\.secrets.production.json
pnpm exec wrangler secret list
```

Confirm that the secret list contains all five required names. Later code-only deployments use `pnpm deploy`; stored secrets are preserved.

Wrangler builds the Vite browser client, uploads it as Worker static assets, deploys the API, registers the Queue consumer, and installs the cleanup cron. Record the final HTTPS URL, normally:

`https://call-relay.<your-workers-subdomain>.workers.dev`

Test it from PowerShell:

```powershell
$workerUrl = "https://call-relay.<your-workers-subdomain>.workers.dev"
Invoke-RestMethod -Uri "$workerUrl/health"
```

Expected response:

```json
{
  "ok": true,
  "audioStored": false
}
```

After the health check succeeds, remove only the temporary secret payload from the current `cloud` directory:

```powershell
Remove-Item -LiteralPath .\.secrets.production.json
```

Open `$workerUrl` in a desktop browser and confirm the Call Relay console appears. For deployment diagnostics, stream logs without printing secrets:

```powershell
pnpm exec wrangler tail call-relay
```

## 6. Build and install Android

Confirm `android/app/google-services.json` exists, then build from the repository root:

```powershell
cd ..\android
.\scripts\build.ps1
```

This runs Android unit tests, lint and debug APK assembly. The test APK is produced at:

`android/app/build/outputs/apk/debug/app-debug.apk`

Enable Developer options and USB debugging on the Android phone, connect it by USB, unlock it, and approve the computer's debugging key. Then install:

```powershell
.\scripts\install.ps1
```

If more than one device appears in `adb devices`, disconnect the others before running the script. A Play Store release and production signing configuration are not required for this physical compatibility test.

## 7. Configure and enroll Android

Open **Call Relay** on the phone and complete the sections in order:

1. Select **Choose Call Relay as default dialer** and approve the system role dialog.
2. Select **Grant phone, microphone and notification access** and approve every requested permission.
3. Select **Enable the narrow Relay accessibility service**, find **Relay microphone priority**, inspect its narrow scope, and enable it.
4. Under **Enroll and pair**, enter the deployed Worker HTTPS URL.
5. Enter the same enrollment invite stored earlier.
6. Keep or change the device name and select **Enroll this Android**.
7. Record the displayed Android device ID beginning with `dev_`; the iPhone browser needs it.
8. Select the intended SIM. Dual-SIM devices must have exactly one relay SIM selected.

Do not enable Relay Ready until browser pairing and FCM registration are complete.

Android's default-dialer role is required by the platform for the repository's `InCallService` call UI. The preloaded system dialer remains responsible for emergency calls. Reference: [Android `InCallService`](https://developer.android.com/reference/android/telecom/InCallService).

## 8. Enroll and pair the iPhone browser

On the iPhone, preferably in Safari:

1. Open the deployed Worker HTTPS URL.
2. Under **Enroll this browser**, leave **API base** blank because the console is hosted by the same Worker.
3. Enter the enrollment invite and select **Generate key and enroll**.
4. Under **Pair**, enter the Android `dev_…` device ID and select **Create pairing**.
5. The browser displays a one-time QR containing the pairing ID and secret.
6. Use the Android phone's system Camera or Google Lens to scan the QR. Open the `callrelay://pair` link with Call Relay.
7. Confirm Android reports **Pairing confirmed**.
8. On Android, select the intended SIM and select **Turn Relay Ready on**.
9. Confirm Android shows a current FCM token, confirmed pairing, armed relay and no error.

The QR secret is intentionally shown once. If it is lost before Android confirms it, create a new pairing instead of attempting to recover the old secret.

After both devices are enrolled, rotate `ENROLLMENT_INVITE` with `wrangler secret put ENROLLMENT_INVITE`. Existing signed devices continue to work; the old invite can no longer enroll another device.

## 9. Run the first call in controlled stages

Use a consenting person and a normal non-emergency number. Keep the Android phone in a private, quiet room because its speaker is audible and its microphone captures the room.

### 9.1 Prove Android capture first

1. Place a normal local carrier call from Android.
2. In Call Relay, select **Start independent microphone probe** while the call is active.
3. Ask the cellular participant to speak and then remain silent.
4. Verify that the probe level changes materially with speech.
5. Stop if it remains silent; that handset/firmware is incompatible with this stock acoustic method unless another audio configuration changes the result.

### 9.2 Prove Listen mode

1. Set Android or the browser to **Listen**.
2. For an incoming call, wait for the call ID to appear in the browser, then select **Accept**. Accept automatically joins LiveKit and enables the browser microphone according to the selected mode.
3. Confirm cellular caller audio reaches the iPhone browser.
4. Confirm Android speaker routing remains active and the SIM call does not terminate.

### 9.3 Prove Talk mode

1. Select **Talk**.
2. Speak into the iPhone.
3. Confirm speech plays through Android and reaches the cellular caller.
4. Confirm caller audio is not expected at the iPhone in this diagnostic direction.

### 9.4 Attempt Full duplex

1. Select **Full duplex**.
2. Test alternating speech, silence and simultaneous speech.
3. Listen for runaway echo, chopped speech, excessive gain or complete cancellation of wanted caller audio.
4. Use Listen/Talk or hold-to-talk only to isolate a failure; half duplex is not final acceptance.

For an outgoing relay call, enter an E.164 number such as `+923001234567` in the browser and select **Ask Android to dial**. The browser joins the room automatically; Android receives the FCM command, revalidates the destination and places the call using the selected SIM.

## 10. Complete acceptance before iPhone-native development

The target handset passes only after all of these succeed:

1. one incoming and one outgoing call in Listen mode;
2. one incoming and one outgoing call in Talk mode;
3. usable Full duplex during alternating and simultaneous speech;
4. Android ends the SIM call after the media participant/Internet is unavailable for more than 15 seconds;
5. at least 19 successful calls out of 20 consecutive incoming/outgoing attempts; and
6. one 30-minute Full-duplex call without a crash, runaway echo or broken cleanup.

Record the handset model, Android build, network type, latency symptoms, echo result and every failure. Do not record or commit participant telephone numbers, pairing secrets, device identifiers or audio.

## 11. Troubleshooting and rollback

- **Production preflight fails:** replace every placeholder and keep all five names under `secrets.required`.
- **`no such table`:** apply D1 migrations remotely to `CALL_RELAY_DB`.
- **Browser enrollment returns 401/403:** the invite does not match the Worker secret; rotate it and retry.
- **Android cannot arm Relay Ready:** confirm default-dialer role, all permissions, Accessibility Service, Firebase configuration, FCM token, confirmed pairing and selected SIM.
- **No FCM token:** confirm `google-services.json` belongs to package `dev.zamad.callrelay`, rebuild/reinstall, and verify Google Play services and Internet access.
- **LiveKit authorization fails:** ensure the URL, API key and API secret come from the same LiveKit project.
- **Call audio is silent:** use the independent probe and diagnostic modes; this is often a handset compatibility failure, not a cloud deployment error.
- **Queue delivery fails:** inspect `wrangler tail`, then inspect or attach a temporary consumer to `call-relay-push-dlq` before its messages expire.

To stop the experiment safely:

1. turn Relay Ready off;
2. restore the original Android default Phone app;
3. disable the Relay accessibility service;
4. revoke the LiveKit API key and Firebase service-account key if the environment is being retired; and
5. use `pnpm exec wrangler rollback` if a Worker deployment must be reverted.

Do not delete D1 or Queues until any needed diagnostic metadata has been exported and the exact account/resource targets have been verified.
