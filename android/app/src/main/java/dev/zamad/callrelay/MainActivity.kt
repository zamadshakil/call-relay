package dev.zamad.callrelay

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.role.RoleManager
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.lifecycleScope
import androidx.core.content.ContextCompat
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import dev.zamad.callrelay.accessibility.RelayAccessibilityService
import dev.zamad.callrelay.onboarding.CallRelayConsumerApp
import dev.zamad.callrelay.onboarding.ConsumerCallbacks
import dev.zamad.callrelay.onboarding.OnboardingStage
import dev.zamad.callrelay.onboarding.OnboardingViewModel
import dev.zamad.callrelay.onboarding.SimDiscovery
import dev.zamad.callrelay.onboarding.SimProfile
import dev.zamad.callrelay.push.RelayMessagingService
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

class MainActivity : ComponentActivity() {
    private val viewModel: OnboardingViewModel by viewModels()
    private val setupAdvancing = AtomicBoolean(false)
    private var guidedSetupActive = false
    private var brightnessWasChanged = false
    private var receiverRegistered = false
    private val accountReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                RelayMessagingService.ACTION_PAIRING_CHANGED -> viewModel.pollPairingNow()
                RelayMessagingService.ACTION_ENTITLEMENT_CHANGED -> viewModel.refresh()
            }
        }
    }

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        setupAdvancing.set(false)
        val denied = result.filterValues { !it }.keys
        if (denied.isNotEmpty()) {
            val asked = getSharedPreferences("permission-flow", MODE_PRIVATE)
            val permanent = denied.any { asked.getBoolean(it, false) && !shouldShowRequestPermissionRationale(it) }
            denied.forEach { asked.edit().putBoolean(it, true).apply() }
            guidedSetupActive = false
            viewModel.setupBlocked(
                "Android denied ${denied.joinToString { permissionLabel(it) }}. This access is required for relay calling.",
                permanent,
            )
        } else {
            advanceGuidedSetup()
        }
    }

    private val dialerRoleLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        setupAdvancing.set(false)
        if (isDefaultDialer()) advanceGuidedSetup() else {
            guidedSetupActive = false
            viewModel.setupBlocked("Call Relay must be selected as the default phone app.", false)
        }
    }

    private val accessibilityLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        setupAdvancing.set(false)
        if (accessibilityEnabled()) advanceGuidedSetup() else {
            guidedSetupActive = false
            viewModel.setupBlocked("Enable “Relay microphone priority” in Accessibility settings, then return.", false)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        viewModel.setPrerequisitesComplete(allPrerequisitesComplete())
        handleIntent(intent)
        setContent {
            val state by viewModel.state.collectAsState()
            val context = LocalContext.current
            val simChoices = remember(state.stage, allPrerequisitesComplete()) {
                if (allPrerequisitesComplete()) SimDiscovery.choices(context) else emptyList()
            }
            LaunchedEffect(state.stage, simChoices) {
                if (state.stage == OnboardingStage.SIM && simChoices.size == 1 && !simChoices.single().detectedNumber.isNullOrBlank()) {
                    viewModel.saveSim(SimDiscovery.profile(simChoices.single(), null))
                }
                if (state.stage == OnboardingStage.PAIRING) viewModel.ensurePairingInvitation()
            }
            CallRelayConsumerApp(
                state,
                simChoices,
                ConsumerCallbacks(
                    signIn = ::signInWithGoogle,
                    selectPlan = { plan -> viewModel.selectPlan(plan, ::openCustomTab) },
                    checkPayment = viewModel::paymentReturned,
                    beginSetup = ::beginGuidedSetup,
                    retrySetup = ::beginGuidedSetup,
                    openAppSettings = ::openAppSettings,
                    replaceAndroid = viewModel::replaceAndroid,
                    saveSim = ::saveSimSafely,
                    refreshQr = viewModel::replaceQr,
                    shareQr = ::sharePairingLink,
                    brightenQr = ::setQrBrightness,
                    toggleRelay = viewModel::toggleRelay,
                    managePlan = { viewModel.managePlan(::openCustomTab) },
                    addPeer = viewModel::addPeer,
                    replacePeer = viewModel::replacePeer,
                    signOut = viewModel::signOut,
                ),
            )
        }
        lifecycleScope.launch {
            if (viewModel.guidedSetupWasStarted() && !allPrerequisitesComplete()) {
                guidedSetupActive = true
                advanceGuidedSetup()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        val complete = allPrerequisitesComplete()
        viewModel.setPrerequisitesComplete(complete)
        if (complete) guidedSetupActive = false
        else if (guidedSetupActive && !setupAdvancing.get()) advanceGuidedSetup()
        if (viewModel.state.value.stage == OnboardingStage.PAYMENT) viewModel.paymentReturned()
        viewModel.pollPairingNow()
    }

    override fun onStart() {
        super.onStart()
        if (!receiverRegistered) {
            val filter = IntentFilter(RelayMessagingService.ACTION_PAIRING_CHANGED).apply {
                addAction(RelayMessagingService.ACTION_ENTITLEMENT_CHANGED)
            }
            ContextCompat.registerReceiver(this, accountReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            receiverRegistered = true
        }
    }

    override fun onStop() {
        if (receiverRegistered) {
            unregisterReceiver(accountReceiver)
            receiverRegistered = false
        }
        super.onStop()
    }

    override fun onPause() {
        if (brightnessWasChanged) setQrBrightness(false)
        super.onPause()
    }

    private fun beginGuidedSetup() {
        guidedSetupActive = true
        viewModel.startGuidedSetup()
        advanceGuidedSetup()
    }

    private fun advanceGuidedSetup() {
        if (!guidedSetupActive || !setupAdvancing.compareAndSet(false, true)) return
        val phoneMissing = phonePermissions().filterNot(::permissionGranted)
        when {
            phoneMissing.isNotEmpty() -> permissionLauncher.launch(phoneMissing.toTypedArray())
            !permissionGranted(Manifest.permission.RECORD_AUDIO) -> permissionLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
            Build.VERSION.SDK_INT >= 33 && !permissionGranted(Manifest.permission.POST_NOTIFICATIONS) ->
                permissionLauncher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            !isDefaultDialer() -> {
                val roleManager = getSystemService(RoleManager::class.java)
                if (!roleManager.isRoleAvailable(RoleManager.ROLE_DIALER)) {
                    setupAdvancing.set(false)
                    guidedSetupActive = false
                    viewModel.setupBlocked("This Android build does not expose the default dialer role.", false)
                } else {
                    dialerRoleLauncher.launch(roleManager.createRequestRoleIntent(RoleManager.ROLE_DIALER))
                }
            }
            !accessibilityEnabled() -> accessibilityLauncher.launch(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            else -> {
                setupAdvancing.set(false)
                guidedSetupActive = false
                viewModel.setPrerequisitesComplete(true)
            }
        }
    }

    private fun signInWithGoogle() {
        lifecycleScope.launch {
            runCatching {
                val clientId = webClientId()
                require(!clientId.startsWith("replace-me")) {
                    "Google sign-in is not configured yet. Regenerate google-services.json after adding the Web OAuth client and signing fingerprints."
                }
                val manager = CredentialManager.create(this@MainActivity)
                val credential = try {
                    getGoogleCredential(manager, clientId, true)
                } catch (_: NoCredentialException) {
                    getGoogleCredential(manager, clientId, false)
                }
                require(credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    "Google returned an unsupported credential"
                }
                val google = GoogleIdTokenCredential.createFrom(credential.data)
                val firebase = FirebaseAuth.getInstance().signInWithCredential(
                    GoogleAuthProvider.getCredential(google.idToken, null),
                ).await().user ?: error("Firebase did not return a user")
                require(firebase.isEmailVerified) { "Use a verified Google email address" }
                viewModel.signedIn(firebase)
            }.onFailure(viewModel::reportError)
        }
    }

    private suspend fun getGoogleCredential(manager: CredentialManager, clientId: String, authorizedOnly: Boolean) = manager.getCredential(
        context = this,
        request = GetCredentialRequest.Builder()
            .addCredentialOption(
                GetGoogleIdOption.Builder()
                    .setFilterByAuthorizedAccounts(authorizedOnly)
                    .setAutoSelectEnabled(authorizedOnly)
                    .setServerClientId(clientId)
                    .build(),
            )
            .build(),
    ).credential

    private fun webClientId(): String {
        val generated = resources.getIdentifier("default_web_client_id", "string", packageName)
        return if (generated != 0) getString(generated) else getString(R.string.google_web_client_id)
    }

    private fun saveSimSafely(profile: SimProfile) {
        runCatching { viewModel.saveSim(profile) }.onFailure(viewModel::reportError)
    }

    private fun handleIntent(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme == "callrelay" && uri.host == "billing" && uri.path == "/complete") {
            viewModel.paymentReturned()
            intent.data = null
        }
    }

    private fun openCustomTab(url: String) {
        runCatching { CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(this, Uri.parse(url)) }
            .onFailure(viewModel::reportError)
    }

    private fun sharePairingLink(url: String) {
        startActivity(Intent.createChooser(
            Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url),
            "Share secure pairing link",
        ))
    }

    private fun setQrBrightness(enabled: Boolean) {
        val attributes = window.attributes
        attributes.screenBrightness = if (enabled) 1f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
        window.attributes = attributes
        brightnessWasChanged = enabled
    }

    private fun openAppSettings() {
        guidedSetupActive = true
        viewModel.clearSetupIssue()
        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    }

    private fun allPrerequisitesComplete(): Boolean = phonePermissions().all(::permissionGranted) &&
        permissionGranted(Manifest.permission.RECORD_AUDIO) &&
        (Build.VERSION.SDK_INT < 33 || permissionGranted(Manifest.permission.POST_NOTIFICATIONS)) &&
        isDefaultDialer() && accessibilityEnabled()

    private fun phonePermissions(): List<String> = listOf(
        Manifest.permission.CALL_PHONE,
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.READ_PHONE_NUMBERS,
        Manifest.permission.ANSWER_PHONE_CALLS,
    )

    private fun permissionGranted(permission: String): Boolean = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    private fun permissionLabel(permission: String): String = when (permission) {
        Manifest.permission.RECORD_AUDIO -> "microphone"
        Manifest.permission.POST_NOTIFICATIONS -> "notifications"
        else -> "phone"
    }

    private fun isDefaultDialer(): Boolean = getSystemService(RoleManager::class.java).isRoleHeld(RoleManager.ROLE_DIALER)

    private fun accessibilityEnabled(): Boolean {
        val target = RelayAccessibilityService::class.java.name
        return getSystemService(AccessibilityManager::class.java)
            .getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { info ->
                val service = info.resolveInfo?.serviceInfo ?: return@any false
                val className = if (service.name.startsWith(".")) service.packageName + service.name else service.name
                service.packageName == packageName && className == target
            }
    }
}
