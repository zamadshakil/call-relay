package dev.zamad.callrelay.telecom

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IncomingNumberNormalizationTest {
    @Test
    fun formatsInternationalAndDomesticTelecomHandlesAsE164() {
        assertEquals("+923001234567", normalizeIncomingPhoneNumber("0300 1234567", "pk"))
        assertEquals("+14155552671", normalizeIncomingPhoneNumber("+1 (415) 555-2671", null))
        assertEquals("+442079460018", normalizeIncomingPhoneNumber("0044 20 7946 0018", "gb"))
    }

    @Test
    fun leavesPrivateAndInvalidCallerIdsAbsent() {
        assertNull(normalizeIncomingPhoneNumber(null, "pk"))
        assertNull(normalizeIncomingPhoneNumber("Private number", "pk"))
        assertNull(normalizeIncomingPhoneNumber("123", "pk"))
    }
}
