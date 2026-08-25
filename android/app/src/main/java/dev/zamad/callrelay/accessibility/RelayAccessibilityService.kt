package dev.zamad.callrelay.accessibility

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import dev.zamad.callrelay.relay.RelayRuntime

class RelayAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        super.onServiceConnected()
        RelayRuntime.update { it.copy(accessibilityEnabled = true) }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally empty. The service requests no window content and observes no app UI.
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        RelayRuntime.update { it.copy(accessibilityEnabled = false) }
        super.onDestroy()
    }
}
