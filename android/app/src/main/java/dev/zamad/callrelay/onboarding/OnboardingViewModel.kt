package dev.zamad.callrelay.onboarding

import android.app.Application
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.installations.FirebaseInstallations
import com.google.firebase.messaging.FirebaseMessaging
import dev.zamad.callrelay.BuildConfig
import dev.zamad.callrelay.crypto.DeviceAgreementIdentity
import dev.zamad.callrelay.crypto.DeviceIdentity
import dev.zamad.callrelay.crypto.PairingCryptoV2
import dev.zamad.callrelay.crypto.SecureSecretStore
import dev.zamad.callrelay.network.ConsumerApiClient
import dev.zamad.callrelay.network.ConsumerApiException
import dev.zamad.callrelay.network.RelayApiClient
import dev.zamad.callrelay.relay.RelayPreferences
import dev.zamad.callrelay.relay.RelayReadyService
import java.security.SecureRandom
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import org.json.JSONObject

enum class OnboardingStage { SPLASH, SIGN_IN, APPROVAL, PLANS, PAYMENT, SETUP, SIM, PAIRING, READY }

data class BillingPlan(val code: String, val formattedPrice: String, val minorAmount: Long)

data class OnboardingUiState(
    val stage: OnboardingStage = OnboardingStage.SPLASH,
    val busy: Boolean = true,
    val email: String = "",
    val displayName: String = "",
    val approvalStatus: String = "unknown",
    val subscriptionStatus: String = "none",
    val activePlan: String? = null,
    val renewalAt: Long? = null,
    val plans: List<BillingPlan> = emptyList(),
    val pairingUrl: String? = null,
    val pairingExpiresAt: Long? = null,
    val peerDeviceId: String? = null,
    val peerName: String? = null,
    val maskedNumber: String? = null,
    val carrierName: String? = null,
    val setupIssue: String? = null,
    val setupPermanentlyDenied: Boolean = false,
    val replacementRequired: Boolean = false,
    val error: String? = null,
)

class OnboardingViewModel(application: Application) : AndroidViewModel(application) {
    private val auth = FirebaseAuth.getInstance()
    private val preferences = RelayPreferences(application)
    private val stateStore = OnboardingStateStore(application)
    private val agreementIdentity = DeviceAgreementIdentity(application)
    private val secureStore = SecureSecretStore(application)
    private val consumerApi = ConsumerApiClient(::idToken)
    private val relayApi = RelayApiClient(preferences)
    private val _state = MutableStateFlow(OnboardingUiState())
    val state: StateFlow<OnboardingUiState> = _state.asStateFlow()
    private var prerequisitesComplete = false
    private var pairingJob: Job? = null

    init {
        viewModelScope.launch {
            stateStore.savedStage()
            restore()
        }
    }

    fun signedIn(user: FirebaseUser) {
        _state.value = _state.value.copy(email = user.email.orEmpty(), displayName = user.displayName.orEmpty(), busy = true, error = null)
        viewModelScope.launch { loadSession(checkRevoked = true) }
    }

    fun refresh() {
        viewModelScope.launch { loadSession(checkRevoked = false) }
    }

    fun reportError(error: Throwable) = showError(error)

    fun setPrerequisitesComplete(value: Boolean) {
        prerequisitesComplete = value
        if (value && _state.value.stage == OnboardingStage.SETUP) {
            viewModelScope.launch { stateStore.setGuidedSetupStarted(false) }
            _state.value = _state.value.copy(stage = OnboardingStage.SIM, setupIssue = null)
            persistStage(OnboardingStage.SIM)
        }
    }

    fun setupBlocked(message: String, permanentlyDenied: Boolean) {
        _state.value = _state.value.copy(setupIssue = message, setupPermanentlyDenied = permanentlyDenied)
    }

    fun clearSetupIssue() {
        _state.value = _state.value.copy(setupIssue = null, setupPermanentlyDenied = false)
    }

    fun startGuidedSetup() {
        viewModelScope.launch { stateStore.setGuidedSetupStarted(true) }
        clearSetupIssue()
    }

    fun replaceAndroid() {
        viewModelScope.launch {
            runBusy {
                if (ensureDeviceRegistered(replaceExisting = true)) {
                    _state.value = _state.value.copy(replacementRequired = false)
                    moveTo(OnboardingStage.SETUP)
                }
            }
        }
    }

    suspend fun guidedSetupWasStarted(): Boolean = stateStore.guidedSetupStarted()

    fun selectPlan(plan: String, openCheckout: (String) -> Unit) {
        viewModelScope.launch {
            runBusy {
                val checkoutUrl = consumerApi.checkout(plan)
                _state.value = _state.value.copy(stage = OnboardingStage.PAYMENT)
                persistStage(OnboardingStage.PAYMENT)
                openCheckout(checkoutUrl)
                pollEntitlement()
            }
        }
    }

    fun paymentReturned() {
        _state.value = _state.value.copy(stage = OnboardingStage.PAYMENT, busy = true, error = null)
        viewModelScope.launch { pollEntitlement() }
    }

    fun saveSim(profile: SimProfile) {
        viewModelScope.launch {
            runBusy {
                preferences.selectedPhoneAccount = profile.phoneAccountKey
                relayApi.updateSimProfile(
                    profile.slotIndex,
                    profile.carrierName,
                    profile.countryIso,
                    profile.numberSource,
                    profile.phoneNumber,
                )
                preferences.simProfileUploaded = true
                _state.value = _state.value.copy(
                    stage = OnboardingStage.PAIRING,
                    carrierName = profile.carrierName,
                    maskedNumber = profile.phoneNumber?.takeLast(4)?.let { "••••$it" },
                )
                persistStage(OnboardingStage.PAIRING)
                createPairingInvitation()
            }
        }
    }

    fun ensurePairingInvitation() {
        if (_state.value.stage != OnboardingStage.PAIRING || _state.value.pairingUrl != null) return
        viewModelScope.launch { runBusy { createPairingInvitation() } }
    }

    fun replaceQr() {
        pairingJob?.cancel()
        viewModelScope.launch { runBusy { createPairingInvitation() } }
    }

    fun pollPairingNow() {
        if (_state.value.stage == OnboardingStage.PAIRING) viewModelScope.launch { confirmPendingPairing() }
    }

    fun toggleRelay(ready: Boolean) {
        val application = getApplication<Application>()
        val intent = Intent(application, RelayReadyService::class.java).setAction(
            if (ready) RelayReadyService.ACTION_START else RelayReadyService.ACTION_STOP,
        )
        if (ready) ContextCompat.startForegroundService(application, intent) else application.startService(intent)
    }

    fun managePlan(openUrl: (String) -> Unit) {
        viewModelScope.launch { runBusy { openUrl(consumerApi.portal()) } }
    }

    fun replacePeer() {
        viewModelScope.launch {
            runBusy {
                val peerDeviceId = _state.value.peerDeviceId
                    ?: throw IllegalStateException("No paired iPhone browser is registered")
                toggleRelay(false)
                consumerApi.revoke(peerDeviceId)
                pairingJob?.cancel()
                secureStore.put(PENDING_INVITATION, "")
                preferences.pairingId = ""
                preferences.pairingSecret = ""
                preferences.pairingConfirmed = false
                _state.value = _state.value.copy(
                    stage = OnboardingStage.PAIRING,
                    pairingUrl = null,
                    pairingExpiresAt = null,
                    peerDeviceId = null,
                    peerName = null,
                )
                persistStage(OnboardingStage.PAIRING)
                createPairingInvitation()
            }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            runCatching { if (preferences.deviceId.isNotBlank()) consumerApi.revoke(preferences.deviceId) }
            toggleRelay(false)
            preferences.deviceId = ""
            preferences.pairingId = ""
            preferences.pairingSecret = ""
            preferences.pairingConfirmed = false
            preferences.simProfileUploaded = false
            preferences.entitlementActive = false
            auth.signOut()
            stateStore.setGuidedSetupStarted(false)
            _state.value = OnboardingUiState(stage = OnboardingStage.SIGN_IN, busy = false)
            persistStage(OnboardingStage.SIGN_IN)
        }
    }

    private suspend fun restore() {
        val user = auth.currentUser
        if (user == null) {
            _state.value = OnboardingUiState(stage = OnboardingStage.SIGN_IN, busy = false)
            persistStage(OnboardingStage.SIGN_IN)
        } else {
            _state.value = _state.value.copy(email = user.email.orEmpty(), displayName = user.displayName.orEmpty())
            loadSession(checkRevoked = false)
        }
    }

    private suspend fun loadSession(checkRevoked: Boolean) {
        runBusy {
            val snapshot = if (checkRevoked) consumerApi.session() else consumerApi.me()
            applySnapshot(snapshot)
            routeFromSnapshot(snapshot)
        }
    }

    private suspend fun routeFromSnapshot(snapshot: JSONObject) {
        val account = snapshot.getJSONObject("account")
        val subscription = snapshot.getJSONObject("subscription")
        val approval = account.getString("approvalStatus")
        val active = subscription.optBoolean("active")
        preferences.accountEmail = account.getString("email")
        preferences.entitlementActive = active
        when {
            approval != "approved" -> moveTo(OnboardingStage.APPROVAL)
            !active -> {
                loadPlans()
                moveTo(if (subscription.optString("status") == "pending") OnboardingStage.PAYMENT else OnboardingStage.PLANS)
            }
            else -> {
                if (!ensureDeviceRegistered()) return
                val serverPairing = snapshot.optJSONObject("pairing")
                val serverPairingId = serverPairing?.optString("id")?.ifBlank { null }
                val serverPairingConfirmed = serverPairing != null && !serverPairing.isNull("confirmed_at")
                val localPairingReady = serverPairingConfirmed &&
                    preferences.pairingConfirmed &&
                    preferences.pairingId == serverPairingId &&
                    preferences.pairingSecret.isNotBlank()
                if (!localPairingReady && serverPairing == null && preferences.pairingConfirmed) {
                    preferences.pairingId = ""
                    preferences.pairingSecret = ""
                    preferences.pairingConfirmed = false
                }
                when {
                    !prerequisitesComplete -> moveTo(OnboardingStage.SETUP)
                    !preferences.simProfileUploaded -> moveTo(OnboardingStage.SIM)
                    localPairingReady -> {
                        moveTo(OnboardingStage.READY)
                        toggleRelay(true)
                    }
                    serverPairing != null -> {
                        confirmPendingPairing()
                        if (_state.value.stage != OnboardingStage.READY) {
                            moveTo(OnboardingStage.PAIRING)
                            if (serverPairingConfirmed) {
                                _state.value = _state.value.copy(
                                    error = "The server pairing is confirmed but its local security key is unavailable. Sign out and enroll this Android again.",
                                )
                            } else {
                                createPairingInvitation()
                            }
                        }
                    }
                    else -> {
                        moveTo(OnboardingStage.PAIRING)
                        createPairingInvitation()
                    }
                }
            }
        }
    }

    private fun applySnapshot(snapshot: JSONObject) {
        val account = snapshot.getJSONObject("account")
        val subscription = snapshot.getJSONObject("subscription")
        val devices = snapshot.optJSONArray("devices")
        var masked: String? = null
        var carrier: String? = null
        var peerDeviceId: String? = null
        var peerName: String? = null
        for (index in 0 until (devices?.length() ?: 0)) {
            val device = devices?.getJSONObject(index) ?: continue
            if (device.optString("platform") == "android") {
                if (!device.isNull("sim")) {
                    val sim = device.getJSONObject("sim")
                    masked = sim.optString("maskedNumber").ifBlank { null }
                    carrier = sim.optString("carrierName").ifBlank { null }
                }
            } else {
                peerDeviceId = device.optString("id").ifBlank { null }
                peerName = device.optString("displayName").ifBlank { null }
            }
        }
        _state.value = _state.value.copy(
            email = account.optString("email"),
            displayName = account.optString("displayName"),
            approvalStatus = account.optString("approvalStatus"),
            subscriptionStatus = subscription.optString("status", "none"),
            activePlan = subscription.optString("plan").ifBlank { null },
            renewalAt = if (subscription.isNull("currentPeriodEndsAt")) null else subscription.optLong("currentPeriodEndsAt"),
            maskedNumber = masked,
            carrierName = carrier,
            peerDeviceId = peerDeviceId,
            peerName = peerName,
        )
    }

    private suspend fun loadPlans() {
        val response = consumerApi.plans()
        val values = response.getJSONArray("plans")
        val plans = buildList {
            for (index in 0 until values.length()) {
                val plan = values.getJSONObject(index)
                add(BillingPlan(plan.getString("code"), plan.getString("formattedPrice"), plan.getLong("minorAmount")))
            }
        }
        _state.value = _state.value.copy(plans = plans)
    }

    private suspend fun ensureDeviceRegistered(replaceExisting: Boolean = false): Boolean {
        val installationId = runCatching {
            FirebaseMessaging.getInstance().register().await()
            FirebaseInstallations.getInstance().id.await()
        }.getOrNull()
        if (!installationId.isNullOrBlank()) preferences.fcmToken = installationId
        return try {
            preferences.deviceId = consumerApi.registerAndroid(
                displayName = android.os.Build.MODEL.ifBlank { "Android relay phone" },
                publicKeySpki = DeviceIdentity().publicKeySpki(),
                agreementPublicKeyRaw = agreementIdentity.publicKeyRaw(),
                fcmInstallationId = preferences.fcmToken.ifBlank { null },
                replaceExisting = replaceExisting,
            )
            true
        } catch (error: ConsumerApiException) {
            if (error.status != 409 || replaceExisting) throw error
            _state.value = _state.value.copy(
                stage = OnboardingStage.SETUP,
                replacementRequired = true,
                busy = false,
                error = null,
            )
            persistStage(OnboardingStage.SETUP)
            false
        }
    }

    private suspend fun pollEntitlement() {
        repeat(20) {
            val snapshot = consumerApi.me()
            applySnapshot(snapshot)
            if (snapshot.getJSONObject("subscription").optBoolean("active")) {
                if (!ensureDeviceRegistered()) return
                moveTo(OnboardingStage.SETUP)
                return
            }
            delay(1_000)
        }
        _state.value = _state.value.copy(busy = false, error = "Payment is still being verified. Tap Check again in a moment.")
    }

    private suspend fun createPairingInvitation() {
        if (preferences.deviceId.isBlank() && !ensureDeviceRegistered()) return
        val challenge = ByteArray(32).also(SecureRandom()::nextBytes)
        val invitationKeyPair = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
        val invitationPublicKey = PairingCryptoV2.encode(
            PairingCryptoV2.publicKeyRaw(invitationKeyPair.public as ECPublicKey),
        )
        val invitationId = "inv_${UUID.randomUUID().toString().replace("-", "")}"
        val invitation = relayApi.createPairingInvitation(invitationId, PairingCryptoV2.challengeHash(challenge))
        secureStore.put(PENDING_INVITATION, JSONObject()
            .put("id", invitation.invitationId)
            .put("challenge", PairingCryptoV2.encode(challenge))
            .put("privateKey", PairingCryptoV2.encode(invitationKeyPair.private.encoded))
            .put("publicKey", invitationPublicKey)
            .put("expiresAt", invitation.expiresAt)
            .toString())
        val fragment = "v=2&id=${invitation.invitationId}&c=${PairingCryptoV2.encode(challenge)}&k=$invitationPublicKey"
        _state.value = _state.value.copy(
            pairingUrl = "${invitation.pairingUrlBase}#$fragment",
            pairingExpiresAt = invitation.expiresAt,
            busy = false,
        )
        pairingJob?.cancel()
        pairingJob = viewModelScope.launch {
            while (isActive && _state.value.stage == OnboardingStage.PAIRING) {
                delay(2_000)
                if (System.currentTimeMillis() >= invitation.expiresAt - 10_000) {
                    runCatching { createPairingInvitation() }.onFailure(::showError)
                    return@launch
                }
                runCatching { confirmPendingPairing() }.onFailure { /* transient polling failure */ }
            }
        }
    }

    private suspend fun confirmPendingPairing() {
        val pending = relayApi.currentDevicePairing() ?: return
        if (pending.confirmed && pending.pairingId == preferences.pairingId) {
            moveTo(OnboardingStage.READY)
            toggleRelay(true)
            return
        }
        val saved = secureStore.get(PENDING_INVITATION)?.let(::JSONObject) ?: return
        if (saved.getString("id") != pending.invitationId) return
        val challenge = PairingCryptoV2.decode(saved.getString("challenge"))
        val invitationPrivateKey = KeyFactory.getInstance("EC").generatePrivate(
            PKCS8EncodedKeySpec(PairingCryptoV2.decode(saved.getString("privateKey"))),
        )
        val secret = PairingCryptoV2.deriveSecret(
            invitationPrivateKey,
            PairingCryptoV2.decodePublicKey(pending.peerPublicKeyRaw),
            challenge,
        )
        try {
            val commitment = PairingCryptoV2.commitment(secret)
            check(commitment == pending.commitment) { "Pairing commitment did not match" }
            check(PairingCryptoV2.verifyPeerProof(
                secret,
                pending.peerProof,
                pending.invitationId,
                pending.peerDeviceId,
                pending.peerPublicKeyRaw,
                commitment,
            )) { "The iPhone pairing proof was invalid" }
            val proof = PairingCryptoV2.androidProof(
                secret,
                pending.invitationId,
                pending.pairingId,
                preferences.deviceId,
                pending.peerDeviceId,
                commitment,
            )
            relayApi.confirmPairingV2(pending.pairingId, commitment, proof)
            preferences.pairingId = pending.pairingId
            preferences.pairingSecret = PairingCryptoV2.encode(secret)
            preferences.pairingConfirmed = true
            secureStore.put(PENDING_INVITATION, "")
            moveTo(OnboardingStage.READY)
            toggleRelay(true)
        } finally {
            secret.fill(0)
            challenge.fill(0)
        }
    }

    private suspend fun idToken(): String = auth.currentUser?.getIdToken(false)?.await()?.token
        ?: throw IllegalStateException("Sign in again to continue")

    private suspend fun moveTo(stage: OnboardingStage) {
        _state.value = _state.value.copy(stage = stage, busy = false, error = null)
        persistStage(stage)
    }

    private fun persistStage(stage: OnboardingStage) {
        viewModelScope.launch { stateStore.saveStage(stage) }
    }

    private suspend fun runBusy(block: suspend () -> Unit) {
        _state.value = _state.value.copy(busy = true, error = null)
        runCatching { block() }
            .onFailure(::showError)
        _state.value = _state.value.copy(busy = false)
    }

    private fun showError(error: Throwable) {
        if (error is ConsumerApiException && error.status == 401) auth.signOut()
        _state.value = _state.value.copy(
            stage = if (auth.currentUser == null) OnboardingStage.SIGN_IN else _state.value.stage,
            busy = false,
            error = error.message ?: "Something went wrong",
        )
    }

    companion object {
        private const val PENDING_INVITATION = "pairing_invitation_v2"
    }
}

data class SimProfile(
    val phoneAccountKey: String,
    val slotIndex: Int,
    val carrierName: String,
    val countryIso: String,
    val numberSource: String,
    val phoneNumber: String?,
)
