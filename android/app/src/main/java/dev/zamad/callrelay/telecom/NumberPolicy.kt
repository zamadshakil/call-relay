package dev.zamad.callrelay.telecom

object NumberPolicy {
    private val e164 = Regex("^\\+[1-9]\\d{7,14}$")

    fun rejectionReason(number: String): String? = when {
        number.any { it == '*' || it == '#' } -> "MMI and USSD codes are blocked"
        !e164.matches(number) -> "Use a full E.164 number such as +923001234567"
        else -> null
    }
}
