package dev.zamad.callrelay.relay

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.livekit.android.LiveKit
import io.livekit.android.e2ee.BaseKeyProvider
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LiveKitNativeE2eeTest {
    @Test
    fun frameCryptorNativeProviderLoadsAfterLiveKitInitialization() {
        val context = ApplicationProvider.getApplicationContext<Context>()

        LiveKit.init(context)
        val keyProvider = BaseKeyProvider()

        assertTrue(keyProvider.setSharedKey("call-relay-native-smoke-test"))
    }
}
