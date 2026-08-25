package dev.zamad.callrelay.telecom

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class NumberPolicyTest {
    @Test
    fun acceptsE164AndBlocksShortCodesAndMmi() {
        assertNull(NumberPolicy.rejectionReason("+923001234567"))
        assertNotNull(NumberPolicy.rejectionReason("911"))
        assertNotNull(NumberPolicy.rejectionReason("*123#"))
    }
}
