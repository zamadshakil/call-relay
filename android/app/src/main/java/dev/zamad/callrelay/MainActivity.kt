package dev.zamad.callrelay

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.firebase.messaging.FirebaseMessaging
import dev.zamad.callrelay.accessibility.RelayAccessibilityService
import dev.zamad.callrelay.audio.AudioProbeService
import dev.zamad.callrelay.network.RelayApiClient
import dev.zamad.callrelay.probe.ProbeState
import dev.zamad.callrelay.relay.RelayMode
import dev.zamad.callrelay.relay.RelayPreferences
import dev.zamad.callrelay.relay.RelayReadyService
import dev.zamad.callrelay.relay.RelayRuntime
import dev.zamad.callrelay.telecom.NumberPolicy
import dev.zamad.callrelay.telecom.RelayInCallService
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var preferences: RelayPreferences
    private lateinit var setupStatus: TextView
    private lateinit var relayStatus: TextView
    private lateinit var callStatus: TextView
    private lateinit var audioStatus: TextView
    private lateinit var apiBase: EditText
    private lateinit var invite: EditText
    private lateinit var deviceName: EditText
    private lateinit var pairingId: EditText
    private lateinit var pairingSecret: EditText
    private lateinit var phoneNumber: EditText
    private lateinit var simButton: Button

    private val refresh = object : Runnable {
        override fun run() {
            renderStatus()
            handler.postDelayed(this, 350)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        preferences = RelayPreferences(this)
        setContentView(buildUi())
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        handler.post(refresh)
    }

    override fun onStop() {
        handler.removeCallbacks(refresh)
        super.onStop()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun buildUi(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(40))
            setBackgroundColor(Color.rgb(246, 248, 252))
        }
        content.addView(text("Call Relay", 30f, true))
        content.addView(text("Stock Android acoustic SIM relay", 16f, false))
        content.addView(
            text(
                "The SIM call remains on this phone. Its speaker is intentionally audible, and the microphone can capture the room. Audio is not recorded.",
                14f,
                false,
            ).apply { setTextColor(Color.rgb(80, 80, 80)); setPadding(0, dp(10), 0, 0) },
        )

        content.addView(section("1. Required Android access"))
        setupStatus = statusText()
        content.addView(setupStatus)
        content.addView(button("Choose Call Relay as default dialer") { requestDialerRole() })
        content.addView(button("Grant phone, microphone and notification access") { requestRuntimePermissions() })
        content.addView(button("Enable the narrow Relay accessibility service") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        })

        content.addView(section("2. Enroll and pair"))
        apiBase = input("https://your-worker.workers.dev", InputType.TYPE_TEXT_VARIATION_URI).apply {
            setText(preferences.apiBaseUrl)
        }
        invite = input("Enrollment invite", InputType.TYPE_TEXT_VARIATION_PASSWORD)
        deviceName = input("Android relay phone", InputType.TYPE_CLASS_TEXT).apply { setText("Android relay phone") }
        content.addView(label("Worker HTTPS URL", apiBase))
        content.addView(label("Enrollment invite", invite))
        content.addView(label("Device name", deviceName))
        content.addView(button("Enroll this Android") { enrollDevice() })

        pairingId = input("pair_…", InputType.TYPE_CLASS_TEXT).apply { setText(preferences.pairingId) }
        pairingSecret = input("32-byte URL-safe secret", InputType.TYPE_TEXT_VARIATION_PASSWORD).apply {
            setText(preferences.pairingSecret)
        }
        content.addView(label("Pairing ID", pairingId))
        content.addView(label("Pairing secret", pairingSecret))
        content.addView(button("Save pairing from browser / QR") { savePairing() })
        simButton = button("Select SIM") { cycleSim() }
        content.addView(simButton)

        content.addView(section("3. Relay Ready"))
        relayStatus = statusText()
        content.addView(relayStatus)
        content.addView(button("Turn Relay Ready on") { armRelay() })
        content.addView(button("Turn Relay Ready off") { disarmRelay() })

        content.addView(section("4. Cellular call"))
        phoneNumber = input("+923001234567", InputType.TYPE_CLASS_PHONE)
        content.addView(label("E.164 test number", phoneNumber))
        content.addView(button("Place local test call") { placeLocalTestCall() })
        content.addView(button("Answer current call") { RelayInCallService.answer() })
        content.addView(button("End current call") { endCurrentCall() })
        callStatus = statusText()
        content.addView(callStatus)

        content.addView(section("5. Audio direction"))
        content.addView(text("Full duplex is the target. Listen and Talk are diagnostic fallbacks when the device blocks one direction.", 14f, false))
        val modes = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        modes.addView(button("Full duplex") { setMode(RelayMode.FULL_DUPLEX) }, weighted())
        modes.addView(button("Listen") { setMode(RelayMode.LISTEN) }, weighted())
        modes.addView(button("Talk") { setMode(RelayMode.TALK) }, weighted())
        content.addView(modes)
        val pushToTalk = button("Hold to talk (release to listen)") {}
        pushToTalk.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> setMode(RelayMode.TALK)
                MotionEvent.ACTION_UP -> {
                    view.performClick()
                    setMode(RelayMode.LISTEN)
                }
                MotionEvent.ACTION_CANCEL -> setMode(RelayMode.LISTEN)
            }
            true
        }
        content.addView(pushToTalk)

        content.addView(section("6. Cloudflare WebRTC diagnostics"))
        content.addView(text("Relay Ready maintains authenticated pairing signaling. Calls try direct WebRTC first and automatically force encrypted Cloudflare TURN when needed.", 14f, false))

        content.addView(section("7. Call-time microphone gate"))
        content.addView(button("Start independent microphone probe") { startProbe() })
        content.addView(button("Stop independent microphone probe") { stopProbe() })
        audioStatus = statusText()
        content.addView(audioStatus)

        return ScrollView(this).apply { addView(content) }
    }

    private fun renderStatus() {
        val isDialer = getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_DIALER)
        val accessibility = accessibilityEnabled()
        RelayRuntime.update { it.copy(accessibilityEnabled = accessibility) }
        setupStatus.text = buildString {
            append("Default dialer: ${yesNo(isDialer)}\n")
            append("Accessibility service: ${yesNo(accessibility)}\n")
            append("Firebase commands: ${if (BuildConfig.FCM_CONFIGURED) "configured" else "missing google-services.json"}\n")
            append("Android device: ${preferences.deviceId.ifBlank { "not enrolled" }}\n")
            append("Pairing: ${preferences.pairingId.ifBlank { "not configured" }}")
            if (preferences.pairingId.isNotBlank()) append(if (preferences.pairingConfirmed) " (confirmed)" else " (not confirmed)")
        }

        val runtime = RelayRuntime.snapshot()
        relayStatus.text = buildString {
            append("Relay Ready: ${if (runtime.ready) "ON" else "OFF"}\n")
            append("Media: ${runtime.mediaState}\n")
            append("Mode: ${runtime.mode.wireValue}")
            if (runtime.muted) append(" (muted)")
            runtime.callId?.let { append("\nSession: $it") }
            runtime.error?.let { append("\nError: $it") }
        }
        callStatus.text = "Call: ${RelayInCallService.callState()}\nRoute: ${RelayInCallService.audioRoute()}"

        val probe = ProbeState.snapshot()
        audioStatus.text = buildString {
            append(String.format(Locale.US, "Relay capture RMS %.1f / peak %d\n", runtime.captureRms, runtime.capturePeak))
            append("Probe: ${probe.status} (${probe.source})\n")
            append(String.format(Locale.US, "Probe RMS %.1f / peak %d / non-zero %.1f%%", probe.rms, probe.peak, probe.nonZeroRatio * 100.0))
            if (probe.error.isNotBlank()) append("\nProbe error: ${probe.error}")
        }
        simButton.text = "SIM: ${selectedSimLabel()}"
    }

    private fun enrollDevice() {
        preferences.apiBaseUrl = apiBase.text.toString()
        val inviteValue = invite.text.toString()
        val name = deviceName.text.toString().ifBlank { "Android relay phone" }
        if (!preferences.apiBaseUrl.startsWith("https://")) {
            RelayRuntime.update { it.copy(error = "Worker URL must use HTTPS") }
            return
        }
        val completeEnrollment: (String?) -> Unit = { fcmToken ->
            scope.launch {
                runCatching { RelayApiClient(preferences).enroll(inviteValue, name, fcmToken) }
                    .onSuccess { deviceId ->
                        preferences.pairingConfirmed = false
                        RelayRuntime.update { it.copy(error = null, mediaState = "Enrolled $deviceId; create and confirm a new pairing") }
                    }
                    .onFailure { failure -> RelayRuntime.update { it.copy(error = failure.message) } }
            }
        }
        runCatching {
            FirebaseMessaging.getInstance().register().addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    completeEnrollment(preferences.fcmToken.ifBlank { null })
                } else {
                    completeEnrollment(preferences.fcmToken.ifBlank { null })
                }
            }
        }.onFailure { completeEnrollment(preferences.fcmToken.ifBlank { null }) }
    }

    private fun savePairing() {
        preferences.apiBaseUrl = apiBase.text.toString()
        val nextPairingId = pairingId.text.toString().trim()
        val nextPairingSecret = pairingSecret.text.toString().trim()
        if (!Regex("^pair_[a-f0-9]{32}$").matches(nextPairingId) || runCatching {
                dev.zamad.callrelay.crypto.CallKeyDeriver.secretCommitment(nextPairingSecret)
            }.isFailure
        ) {
            RelayRuntime.update { it.copy(error = "Pairing ID or 32-byte pairing secret is invalid") }
            return
        }
        preferences.pairingConfirmed = false
        scope.launch {
            runCatching { RelayApiClient(preferences).confirmPairing(nextPairingId, nextPairingSecret) }
                .onSuccess {
                    preferences.pairingId = nextPairingId
                    preferences.pairingSecret = nextPairingSecret
                    preferences.pairingConfirmed = true
                    RelayRuntime.update { it.copy(error = null, mediaState = "Pairing confirmed") }
                }
                .onFailure { failure -> RelayRuntime.update { it.copy(error = "Pairing confirmation failed: ${failure.message}") } }
        }
    }

    private fun importPairing(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme != "callrelay" || uri.host != "pair") return
        val importedPairing = uri.getQueryParameter("pairingId").orEmpty()
        val importedSecret = uri.getQueryParameter("secret").orEmpty()
        if (importedPairing.isNotBlank() && importedSecret.isNotBlank()) {
            if (::pairingId.isInitialized) pairingId.setText(importedPairing)
            if (::pairingSecret.isInitialized) pairingSecret.setText(importedSecret)
            savePairing()
            intent.data = null
        }
    }

    private fun handleIntent(intent: Intent?) {
        importPairing(intent)
        intent?.data?.schemeSpecificPart
            ?.takeIf { intent.data?.scheme == "tel" }
            ?.let(phoneNumber::setText)
    }

    private fun armRelay() {
        val roleManager = getSystemService(RoleManager::class.java)
        when {
            !roleManager.isRoleHeld(RoleManager.ROLE_DIALER) -> RelayRuntime.update { it.copy(error = "Choose this app as default dialer first") }
            !accessibilityEnabled() -> RelayRuntime.update { it.copy(error = "Enable the Relay accessibility service first") }
            !relayPermissionsGranted() -> {
                RelayRuntime.update { it.copy(error = "Grant all phone, microphone and notification permissions") }
                requestRuntimePermissions()
            }
            !BuildConfig.FCM_CONFIGURED -> RelayRuntime.update { it.copy(error = "Add app/google-services.json and rebuild before enabling Relay Ready") }
            preferences.fcmToken.isBlank() -> RelayRuntime.update { it.copy(error = "Firebase has not issued this phone a push token yet") }
            !preferences.configured() -> RelayRuntime.update { it.copy(error = "Enroll and pair before enabling Relay Ready") }
            phoneAccounts().size > 1 && selectedPhoneAccount() == null -> RelayRuntime.update { it.copy(error = "Select exactly one SIM before enabling Relay Ready") }
            else -> {
                stopProbe()
                startForegroundService(Intent(this, RelayReadyService::class.java).setAction(RelayReadyService.ACTION_START))
            }
        }
    }

    private fun disarmRelay() {
        startService(Intent(this, RelayReadyService::class.java).setAction(RelayReadyService.ACTION_STOP))
    }

    private fun endCurrentCall() {
        RelayInCallService.disconnect()
    }

    private fun setMode(mode: RelayMode) {
        startService(
            Intent(this, RelayReadyService::class.java)
                .setAction(RelayReadyService.ACTION_SET_MODE)
                .putExtra(RelayReadyService.EXTRA_MODE, mode.wireValue),
        )
    }

    private fun placeLocalTestCall() {
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            requestRuntimePermissions()
            return
        }
        val number = phoneNumber.text.toString().trim()
        NumberPolicy.rejectionReason(number)?.let { reason ->
            RelayRuntime.update { it.copy(error = reason) }
            return
        }
        if (getSystemService(TelephonyManager::class.java).isEmergencyNumber(number)) {
            RelayRuntime.update { it.copy(error = "Emergency numbers are blocked from relay") }
            return
        }
        val telecom = getSystemService(TelecomManager::class.java)
        val extras = Bundle()
        selectedPhoneAccount()?.let { extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, it) }
        telecom.placeCall(Uri.fromParts("tel", number, null), extras)
    }

    private fun requestDialerRole() {
        val roleManager = getSystemService(RoleManager::class.java)
        if (roleManager.isRoleAvailable(RoleManager.ROLE_DIALER) && !roleManager.isRoleHeld(RoleManager.ROLE_DIALER)) {
            startActivityForResult(roleManager.createRequestRoleIntent(RoleManager.ROLE_DIALER), REQUEST_DIALER_ROLE)
        }
    }

    private fun requestRuntimePermissions() {
        val requested = mutableListOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.ANSWER_PHONE_CALLS,
            Manifest.permission.RECORD_AUDIO,
        )
        if (Build.VERSION.SDK_INT >= 33) requested += Manifest.permission.POST_NOTIFICATIONS
        requestPermissions(requested.toTypedArray(), REQUEST_PERMISSIONS)
    }

    private fun accessibilityEnabled(): Boolean {
        val manager = getSystemService(AccessibilityManager::class.java)
        val serviceClassName = RelayAccessibilityService::class.java.name
        val managerReportsEnabled = manager
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { info ->
                val service = info.resolveInfo?.serviceInfo
                val normalizedClassName = service?.name?.let { name ->
                    if (name.startsWith(".")) "${service.packageName}$name" else name
                }
                service?.packageName == packageName && normalizedClassName == serviceClassName
            }
        val secureSettingReportsEnabled = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ).orEmpty()
            .split(':')
            .any { component ->
                val separator = component.indexOf('/')
                if (separator <= 0 || separator == component.lastIndex) return@any false
                val servicePackage = component.substring(0, separator)
                val rawClassName = component.substring(separator + 1)
                val normalizedClassName = if (rawClassName.startsWith(".")) {
                    "$servicePackage$rawClassName"
                } else {
                    rawClassName
                }
                servicePackage == packageName && normalizedClassName == serviceClassName
            }
        return managerReportsEnabled || secureSettingReportsEnabled || RelayRuntime.snapshot().accessibilityEnabled
    }

    private fun cycleSim() {
        val accounts = phoneAccounts()
        if (accounts.isEmpty()) return
        val current = accounts.indexOfFirst { accountKey(it) == preferences.selectedPhoneAccount }
        val next = accounts[(current + 1).mod(accounts.size)]
        preferences.selectedPhoneAccount = accountKey(next)
        renderStatus()
    }

    private fun selectedPhoneAccount(): PhoneAccountHandle? {
        val accounts = phoneAccounts()
        return accounts.firstOrNull { accountKey(it) == preferences.selectedPhoneAccount } ?: accounts.singleOrNull()
    }

    private fun phoneAccounts(): List<PhoneAccountHandle> {
        if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return emptyList()
        }
        return getSystemService(TelecomManager::class.java).callCapablePhoneAccounts
    }

    private fun selectedSimLabel(): String {
        val telecom = getSystemService(TelecomManager::class.java)
        val selected = selectedPhoneAccount() ?: return "system choice"
        return telecom.getPhoneAccount(selected)?.label?.toString() ?: selected.id
    }

    private fun accountKey(handle: PhoneAccountHandle): String = "${handle.componentName.flattenToString()}|${handle.id}"

    private fun startProbe() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestRuntimePermissions()
            return
        }
        if (RelayRuntime.snapshot().ready) {
            RelayRuntime.update { it.copy(error = "Turn Relay Ready off before running the independent microphone probe") }
            return
        }
        startForegroundService(Intent(this, AudioProbeService::class.java))
    }

    private fun stopProbe() {
        stopService(Intent(this, AudioProbeService::class.java))
    }

    private fun text(value: String, sizeSp: Float, bold: Boolean): TextView = TextView(this).apply {
        text = value
        textSize = sizeSp
        setTextColor(Color.rgb(30, 30, 30))
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    private fun section(value: String): TextView = text(value, 19f, true).apply { setPadding(0, dp(24), 0, dp(8)) }
    private fun statusText(): TextView = text("-", 14f, false).apply { setPadding(0, dp(8), 0, dp(6)) }
    private fun input(hintText: String, type: Int): EditText = EditText(this).apply {
        hint = hintText
        inputType = type
        setPadding(dp(12), dp(10), dp(12), dp(10))
    }

    private fun label(label: String, field: View): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(text(label, 13f, true).apply { setPadding(0, dp(8), 0, 0) })
        addView(field, matchWrap())
    }

    private fun button(label: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        gravity = Gravity.CENTER
        setOnClickListener { action() }
    }

    private fun weighted() = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
    private fun matchWrap() = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
    private fun yesNo(value: Boolean): String = if (value) "enabled" else "not enabled"

    private fun relayPermissionsGranted(): Boolean {
        val required = mutableListOf(
            Manifest.permission.CALL_PHONE,
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.ANSWER_PHONE_CALLS,
            Manifest.permission.RECORD_AUDIO,
        )
        if (Build.VERSION.SDK_INT >= 33) required += Manifest.permission.POST_NOTIFICATIONS
        return required.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    }

    companion object {
        private const val REQUEST_DIALER_ROLE = 100
        private const val REQUEST_PERMISSIONS = 101
    }
}
