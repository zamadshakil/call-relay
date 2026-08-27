package dev.zamad.callrelay.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceHeartbeatTest {
    @Test
    fun carriesOnlyPresenceAndLifecycleMetadata() {
        val heartbeat = DeviceHeartbeat("service-1", 7, true, "Connected", null, 1234, null)
        assertEquals(7, heartbeat.sequence)
        assertTrue(heartbeat.relayReady)
        assertEquals("Connected", heartbeat.signalState)
        assertNull(heartbeat.activeCallId)
        assertNull(heartbeat.lastErrorCode)
    }

    @Test
    fun identityAndSequenceSurviveServiceRecreationWithinProcess() {
        val identity = DeviceHeartbeatIdentity.serviceInstanceId
        val first = DeviceHeartbeatIdentity.nextSequence()
        val second = DeviceHeartbeatIdentity.nextSequence()
        assertEquals(identity, DeviceHeartbeatIdentity.serviceInstanceId)
        assertEquals(first + 1, second)
    }
}
