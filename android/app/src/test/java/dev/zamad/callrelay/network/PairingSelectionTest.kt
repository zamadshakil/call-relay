package dev.zamad.callrelay.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingSelectionTest {
    @Test
    fun twoPeersRequireAnExplicitWinnerWhenThereIsNoPreferredPairing() {
        val selection = PairingSelection()

        selection.update(setOf("pair_browser", "pair_ios"))

        assertNull(selection.selectedId())
        assertTrue(selection.select("pair_ios"))
        assertEquals("pair_ios", selection.selectedId())
    }

    @Test
    fun staleOrRevokedWinnerCannotRemainSelected() {
        val selection = PairingSelection()
        selection.update(setOf("pair_browser", "pair_ios"))
        assertTrue(selection.select("pair_ios"))

        selection.update(setOf("pair_browser"))

        assertEquals("pair_browser", selection.selectedId())
        assertFalse(selection.select("pair_revoked"))
        assertEquals("pair_browser", selection.selectedId())
    }
}
