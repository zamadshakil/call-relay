package dev.zamad.callrelay.onboarding

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.onboardingDataStore by preferencesDataStore(name = "consumer-onboarding")

class OnboardingStateStore(private val context: Context) {
    suspend fun saveStage(stage: OnboardingStage) {
        context.onboardingDataStore.edit { it[STAGE] = stage.name }
    }

    suspend fun savedStage(): OnboardingStage = context.onboardingDataStore.data.first()[STAGE]
        ?.let { runCatching { OnboardingStage.valueOf(it) }.getOrNull() }
        ?: OnboardingStage.SPLASH

    suspend fun setGuidedSetupStarted(value: Boolean) {
        context.onboardingDataStore.edit { it[SETUP_STARTED] = value }
    }

    suspend fun guidedSetupStarted(): Boolean = context.onboardingDataStore.data.first()[SETUP_STARTED] ?: false

    companion object {
        private val STAGE = stringPreferencesKey("stage")
        private val SETUP_STARTED = booleanPreferencesKey("guided_setup_started")
    }
}
