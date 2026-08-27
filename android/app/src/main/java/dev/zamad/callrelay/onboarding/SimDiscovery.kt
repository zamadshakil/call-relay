package dev.zamad.callrelay.onboarding

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import com.google.i18n.phonenumbers.PhoneNumberUtil

data class SimChoice(
    val label: String,
    val phoneAccountKey: String,
    val slotIndex: Int,
    val carrierName: String,
    val countryIso: String,
    val detectedNumber: String?,
)

object SimDiscovery {
    fun choices(context: Context): List<SimChoice> {
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return emptyList()
        val telecom = context.getSystemService(TelecomManager::class.java)
        val subscriptions = context.getSystemService(SubscriptionManager::class.java)
            .activeSubscriptionInfoList.orEmpty()
            .sortedBy(SubscriptionInfo::getSimSlotIndex)
        return telecom.callCapablePhoneAccounts.mapIndexed { index, handle ->
            val account = telecom.getPhoneAccount(handle)
            val subscription = matchSubscription(handle, subscriptions, index)
            val carrier = subscription?.carrierName?.toString()?.ifBlank { null }
                ?: account?.label?.toString()?.ifBlank { null }
                ?: "SIM ${index + 1}"
            val country = subscription?.countryIso?.uppercase()?.takeIf { it.length == 2 }
                ?: context.getSystemService(TelephonyManager::class.java).networkCountryIso.uppercase().takeIf { it.length == 2 }
                ?: "PK"
            SimChoice(
                label = "$carrier · SIM ${subscription?.simSlotIndex?.plus(1) ?: index + 1}",
                phoneAccountKey = accountKey(handle),
                slotIndex = subscription?.simSlotIndex?.coerceAtLeast(0) ?: index,
                carrierName = carrier,
                countryIso = country,
                detectedNumber = subscription?.let { readNumber(context, it) },
            )
        }
    }

    fun profile(choice: SimChoice, enteredNumber: String?): SimProfile {
        val detected = choice.detectedNumber?.let { normalize(it, choice.countryIso) }
        val confirmed = enteredNumber?.trim()?.takeIf(String::isNotEmpty)?.let { normalize(it, choice.countryIso) }
        val number = detected ?: confirmed
        return SimProfile(
            phoneAccountKey = choice.phoneAccountKey,
            slotIndex = choice.slotIndex,
            carrierName = choice.carrierName,
            countryIso = choice.countryIso,
            numberSource = when {
                detected != null -> "subscription"
                confirmed != null -> "user_confirmed"
                else -> "unavailable"
            },
            phoneNumber = number,
        )
    }

    fun normalize(value: String, countryIso: String): String {
        val utility = PhoneNumberUtil.getInstance()
        val parsed = utility.parse(value, countryIso)
        require(utility.isValidNumber(parsed)) { "Enter a valid phone number" }
        return utility.format(parsed, PhoneNumberUtil.PhoneNumberFormat.E164)
    }

    private fun matchSubscription(handle: PhoneAccountHandle, subscriptions: List<SubscriptionInfo>, index: Int): SubscriptionInfo? =
        subscriptions.firstOrNull { handle.id.contains(it.subscriptionId.toString()) }
            ?: subscriptions.getOrNull(index)

    @Suppress("DEPRECATION")
    private fun readNumber(context: Context, subscription: SubscriptionInfo): String? = runCatching {
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) != PackageManager.PERMISSION_GRANTED) return@runCatching null
        val value = if (Build.VERSION.SDK_INT >= 33) {
            context.getSystemService(SubscriptionManager::class.java).getPhoneNumber(subscription.subscriptionId)
        } else {
            subscription.number
        }
        value?.trim()?.takeIf(String::isNotBlank)
    }.getOrNull()

    fun accountKey(handle: PhoneAccountHandle): String = "${handle.componentName.flattenToString()}|${handle.id}"
}
