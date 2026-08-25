package dev.zamad.callrelay.telecom

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            ACTION_ANSWER -> RelayInCallService.answer()
            ACTION_END -> RelayInCallService.disconnect()
        }
    }

    companion object {
        const val ACTION_ANSWER = "dev.zamad.callrelay.action.LOCAL_ANSWER"
        const val ACTION_END = "dev.zamad.callrelay.action.LOCAL_END"
    }
}
