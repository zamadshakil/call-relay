package dev.zamad.callrelay.onboarding

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import dev.zamad.callrelay.relay.RelayRuntime
import dev.zamad.callrelay.telecom.RelayInCallService
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.delay

data class ConsumerCallbacks(
    val signIn: () -> Unit,
    val selectPlan: (String) -> Unit,
    val checkPayment: () -> Unit,
    val beginSetup: () -> Unit,
    val retrySetup: () -> Unit,
    val openAppSettings: () -> Unit,
    val replaceAndroid: () -> Unit,
    val saveSim: (SimProfile) -> Unit,
    val refreshQr: () -> Unit,
    val shareQr: (String) -> Unit,
    val brightenQr: (Boolean) -> Unit,
    val toggleRelay: (Boolean) -> Unit,
    val managePlan: () -> Unit,
    val replacePeer: () -> Unit,
    val signOut: () -> Unit,
)

@Composable
fun CallRelayConsumerApp(
    state: OnboardingUiState,
    simChoices: List<SimChoice>,
    callbacks: ConsumerCallbacks,
) {
    MaterialTheme(colorScheme = lightColorScheme(
        primary = Color(0xFF0B57D0),
        secondary = Color(0xFF006C4C),
        background = Color(0xFFF7F9FC),
        surface = Color.White,
    )) {
        val navController = rememberNavController()
        LaunchedEffect(state.stage) {
            val route = state.stage.name
            if (navController.currentDestination?.route != route) {
                navController.navigate(route) {
                    launchSingleTop = true
                    popUpTo(navController.graph.startDestinationId) { inclusive = route == OnboardingStage.SPLASH.name }
                }
            }
        }
        Scaffold { padding ->
            NavHost(
                navController = navController,
                startDestination = OnboardingStage.SPLASH.name,
                modifier = Modifier.padding(padding),
            ) {
                composable(OnboardingStage.SPLASH.name) { LoadingScreen() }
                composable(OnboardingStage.SIGN_IN.name) { SignInScreen(state, callbacks.signIn) }
                composable(OnboardingStage.APPROVAL.name) { ApprovalScreen(state, callbacks.signOut) }
                composable(OnboardingStage.PLANS.name) { PlansScreen(state, callbacks.selectPlan, callbacks.signOut) }
                composable(OnboardingStage.PAYMENT.name) { PaymentScreen(state, callbacks.checkPayment) }
                composable(OnboardingStage.SETUP.name) {
                    if (state.replacementRequired) ReplacementScreen(state, callbacks.replaceAndroid, callbacks.signOut)
                    else SetupScreen(state, callbacks.beginSetup, callbacks.retrySetup, callbacks.openAppSettings)
                }
                composable(OnboardingStage.SIM.name) { SimScreen(state, simChoices, callbacks.saveSim) }
                composable(OnboardingStage.PAIRING.name) { PairingScreen(state, callbacks.refreshQr, callbacks.shareQr, callbacks.brightenQr) }
                composable(OnboardingStage.READY.name) { ReadyScreen(state, callbacks) }
            }
        }
    }
}

@Composable
private fun Page(title: String, subtitle: String, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Surface(shape = RoundedCornerShape(14.dp), color = MaterialTheme.colorScheme.primary) {
                Image(Icons.Default.Phone, "Call Relay", modifier = Modifier.padding(10.dp).size(24.dp))
            }
            Text("Call Relay", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(10.dp))
        Text(title, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text(subtitle, color = MaterialTheme.colorScheme.onSurfaceVariant)
        content()
    }
}

@Composable
private fun LoadingScreen() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
private fun SignInScreen(state: OnboardingUiState, signIn: () -> Unit) = Page(
    "Your calls, on your iPhone",
    "Use the same approved Google account on this Android and your iPhone browser.",
) {
    StatusMessages(state)
    Button(signIn, Modifier.fillMaxWidth(), enabled = !state.busy) { Text("Continue with Google") }
    Text("Your SIM call stays on this Android. Audio is relayed privately over encrypted WebRTC and is never recorded.")
}

@Composable
private fun ApprovalScreen(state: OnboardingUiState, signOut: () -> Unit) = Page(
    if (state.approvalStatus == "suspended") "Account suspended" else "Approval required",
    if (state.approvalStatus == "suspended") "Call and device access is unavailable for this account." else "${state.email} is not on the approved customer list yet.",
) {
    StatusMessages(state)
    OutlinedButton(signOut, Modifier.fillMaxWidth()) { Text("Use another Google account") }
    Text("Contact support to request access. Payment is unavailable until the account is approved.")
}

@Composable
private fun PlansScreen(state: OnboardingUiState, selectPlan: (String) -> Unit, signOut: () -> Unit) = Page(
    "Choose your plan",
    "One Android relay and one iPhone browser peer. Taxes and currency are calculated by Paddle.",
) {
    val monthly = state.plans.firstOrNull { it.code == "monthly" }
    val annual = state.plans.firstOrNull { it.code == "annual" }
    val savingPercent = if (monthly != null && annual != null && monthly.minorAmount > 0) {
        ((1.0 - annual.minorAmount.toDouble() / (monthly.minorAmount.toDouble() * 12.0)) * 100.0)
            .coerceAtLeast(0.0)
            .toInt()
    } else 0
    state.plans.sortedBy { it.code != "monthly" }.forEach { plan ->
        Card(colors = CardDefaults.cardColors(containerColor = if (plan.code == "annual") Color(0xFFEAF2FF) else Color.White)) {
            Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(if (plan.code == "annual") "Annual" else "Monthly", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(plan.formattedPrice + if (plan.code == "annual") " / year" else " / month")
                if (plan.code == "annual" && savingPercent > 0) Text("Save $savingPercent% compared with 12 monthly payments", color = MaterialTheme.colorScheme.secondary)
                Button({ selectPlan(plan.code) }, Modifier.fillMaxWidth(), enabled = !state.busy) { Text("Choose ${plan.code}") }
            }
        }
    }
    StatusMessages(state)
    OutlinedButton(signOut, Modifier.fillMaxWidth()) { Text("Sign out") }
}

@Composable
private fun PaymentScreen(state: OnboardingUiState, checkPayment: () -> Unit) = Page(
    "Confirming payment",
    "Your browser return does not unlock calling. We wait for Paddle's signed payment notification.",
) {
    CircularProgressIndicator()
    StatusMessages(state)
    Button(checkPayment, Modifier.fillMaxWidth(), enabled = !state.busy) { Text("Check payment again") }
}

@Composable
private fun ReplacementScreen(state: OnboardingUiState, replace: () -> Unit, signOut: () -> Unit) = Page(
    "Replace the existing Android?",
    "This Google account already owns another Android relay.",
) {
    ErrorCard("Replacing it revokes the old Android and its current iPhone pairing.")
    Button(replace, Modifier.fillMaxWidth(), enabled = !state.busy) { Text("Replace old Android") }
    OutlinedButton(signOut, Modifier.fillMaxWidth()) { Text("Use another Google account") }
    StatusMessages(state)
}

@Composable
private fun SetupScreen(state: OnboardingUiState, begin: () -> Unit, retry: () -> Unit, settings: () -> Unit) = Page(
    "Set up this Android",
    "Android will show protected system screens. You must confirm them; Call Relay cannot approve them for you.",
) {
    PermissionRow("Phone", "Place, answer, and observe SIM calls")
    PermissionRow("Microphone", "Relay audible call audio")
    PermissionRow("Notifications", "Stay available for remote call requests")
    PermissionRow("Default dialer", "Receive the carrier call lifecycle")
    PermissionRow("Accessibility", "Give the relay microphone priority during calls")
    state.setupIssue?.let {
        ErrorCard(it)
        Button(if (state.setupPermanentlyDenied) settings else retry, Modifier.fillMaxWidth()) {
            Text(if (state.setupPermanentlyDenied) "Open app settings" else "Retry setup")
        }
    } ?: Button(begin, Modifier.fillMaxWidth(), enabled = !state.busy) { Text("Set up Call Relay") }
    Text("Accessibility is used only while relay is enabled. It never taps dialogs or reads screen content.")
}

@Composable
private fun PermissionRow(name: String, reason: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        Image(Icons.Default.CheckCircle, null, modifier = Modifier.size(22.dp))
        Column { Text(name, fontWeight = FontWeight.SemiBold); Text(reason, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun SimScreen(state: OnboardingUiState, choices: List<SimChoice>, save: (SimProfile) -> Unit) = Page(
    "Choose the SIM to relay",
    if (choices.size == 1) "We found one call-capable SIM and selected it automatically." else "Select the one SIM that Call Relay may use.",
) {
    var selected by remember(choices) { mutableStateOf(choices.singleOrNull() ?: choices.firstOrNull()) }
    var number by remember(selected) { mutableStateOf(selected?.detectedNumber.orEmpty()) }
    var validationError by remember { mutableStateOf<String?>(null) }
    choices.forEach { choice ->
        Card(onClick = { selected = choice; number = choice.detectedNumber.orEmpty() }) {
            Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = selected == choice, onClick = { selected = choice; number = choice.detectedNumber.orEmpty() })
                Column { Text(choice.label, fontWeight = FontWeight.SemiBold); Text(choice.countryIso) }
            }
        }
    }
    if (selected != null && selected?.detectedNumber.isNullOrBlank()) {
        OutlinedTextField(
            value = number,
            onValueChange = { number = it },
            label = { Text("SIM phone number (E.164)") },
            placeholder = { Text("+923001234567") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )
        Text("Android did not expose the number. Enter it once, or leave blank; it is never used to authenticate you.")
    }
    StatusMessages(state)
    validationError?.let { ErrorCard(it) }
    Button(
        onClick = {
            selected?.let { choice ->
                runCatching { SimDiscovery.profile(choice, number) }
                    .onSuccess { validationError = null; save(it) }
                    .onFailure { validationError = it.message ?: "Enter a valid phone number" }
            }
        },
        modifier = Modifier.fillMaxWidth(),
        enabled = selected != null && !state.busy,
    ) { Text("Continue") }
}

@Composable
private fun PairingScreen(
    state: OnboardingUiState,
    refresh: () -> Unit,
    share: (String) -> Unit,
    brighten: (Boolean) -> Unit,
) = Page("Pair your iPhone", "On your iPhone, sign in at call-relay.zamadshakil.workers.dev and scan this code.") {
    val remaining by produceState(0L, state.pairingExpiresAt) {
        while (true) {
            value = ((state.pairingExpiresAt ?: 0L) - System.currentTimeMillis()).coerceAtLeast(0L) / 1000
            delay(1_000)
        }
    }
    state.pairingUrl?.let { url ->
        val bitmap = remember(url) { qrBitmap(url) }
        Image(bitmap.asImageBitmap(), "Secure pairing QR", Modifier.fillMaxWidth().size(300.dp))
        Text("Expires in ${remaining / 60}:${(remaining % 60).toString().padStart(2, '0')}", fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(refresh, Modifier.weight(1f)) { Text("Refresh") }
            OutlinedButton({ share(url) }, Modifier.weight(1f)) { Text("Share link") }
        }
        Button({ brighten(true) }, Modifier.fillMaxWidth()) { Text("Maximize brightness") }
    } ?: CircularProgressIndicator()
    StatusMessages(state)
    Text("The QR is single-use and carries a five-minute challenge—not a reusable pairing secret.")
}

@Composable
private fun ReadyScreen(state: OnboardingUiState, callbacks: ConsumerCallbacks) = Page(
    "Relay Ready",
    "This Android is paired and available for one iPhone browser peer.",
) {
    var confirmPeerReplacement by remember { mutableStateOf(false) }
    val runtime by produceState(RelayRuntime.snapshot()) {
        while (true) { value = RelayRuntime.snapshot(); delay(750) }
    }
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFFE7F6EC))) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(if (runtime.ready) "Relay is on" else "Relay is paused", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
            Text("Media: ${runtime.mediaState}")
            Text("Carrier call: ${RelayInCallService.callState()}")
            Text("Route: ${RelayInCallService.audioRoute()}")
        }
    }
    InfoCard("Google account", state.email)
    InfoCard(
        "Access",
        if (state.billingRequired) {
            listOfNotNull(state.activePlan?.replaceFirstChar(Char::uppercase), state.renewalAt?.let { "renews ${DateFormat.getDateInstance().format(Date(it))}" })
                .joinToString(" · ")
        } else {
            "Approved account · payment not required"
        },
    )
    InfoCard("SIM", listOfNotNull(state.carrierName, state.maskedNumber).joinToString(" · ").ifBlank { "Configured" })
    InfoCard("Paired peer", state.peerName ?: "iPhone browser")
    Button({ callbacks.toggleRelay(!runtime.ready) }, Modifier.fillMaxWidth()) { Text(if (runtime.ready) "Pause relay" else "Resume relay") }
    if (state.billingRequired) {
        OutlinedButton(callbacks.managePlan, Modifier.fillMaxWidth()) { Text("Manage plan") }
    }
    OutlinedButton(
        onClick = { confirmPeerReplacement = true },
        modifier = Modifier.fillMaxWidth(),
        enabled = runtime.callId == null && !state.busy,
    ) { Text("Replace paired peer") }
    OutlinedButton(callbacks.signOut, Modifier.fillMaxWidth()) { Text("Sign out and revoke this Android") }
    StatusMessages(state)
    if (confirmPeerReplacement) {
        AlertDialog(
            onDismissRequest = { confirmPeerReplacement = false },
            title = { Text("Replace the paired iPhone?") },
            text = { Text("The existing browser will be revoked. You will scan a new secure QR on the replacement iPhone.") },
            confirmButton = {
                Button(onClick = {
                    confirmPeerReplacement = false
                    callbacks.replacePeer()
                }) { Text("Replace peer") }
            },
            dismissButton = {
                OutlinedButton(onClick = { confirmPeerReplacement = false }) { Text("Cancel") }
            },
        )
    }
}

@Composable
private fun InfoCard(label: String, value: String) {
    Card { Column(Modifier.fillMaxWidth().padding(14.dp)) { Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant); Text(value, fontWeight = FontWeight.SemiBold) } }
}

@Composable
private fun StatusMessages(state: OnboardingUiState) {
    if (state.busy) CircularProgressIndicator(Modifier.size(24.dp))
    state.error?.let { ErrorCard(it) }
}

@Composable
private fun ErrorCard(message: String) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Text(message, Modifier.fillMaxWidth().padding(14.dp), color = MaterialTheme.colorScheme.onErrorContainer)
    }
}

private fun qrBitmap(value: String): Bitmap {
    val matrix = QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 720, 720)
    val pixels = IntArray(matrix.width * matrix.height)
    for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
        pixels[y * matrix.width + x] = if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    }
    return Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888).apply {
        setPixels(pixels, 0, matrix.width, 0, 0, matrix.width, matrix.height)
    }
}
