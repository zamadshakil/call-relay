package dev.zamad.callrelay.push

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.zamad.callrelay.network.RelayApiClient
import dev.zamad.callrelay.relay.RelayPreferences

class RelaySyncWorker(
    applicationContext: Context,
    parameters: WorkerParameters,
) : CoroutineWorker(applicationContext, parameters) {
    override suspend fun doWork(): Result {
        val preferences = RelayPreferences(applicationContext)
        if (preferences.deviceId.isBlank() || !preferences.apiBaseUrl.startsWith("https://")) return Result.failure()
        return runCatching {
            val api = RelayApiClient(preferences)
            when (inputData.getString(KEY_KIND)) {
                KIND_PUSH_TOKEN -> api.updatePushToken(inputData.getString(KEY_TOKEN).orEmpty())
                KIND_EVENT -> api.event(
                    callId = inputData.getString(KEY_CALL_ID).orEmpty(),
                    type = inputData.getString(KEY_EVENT_TYPE).orEmpty(),
                    code = inputData.getString(KEY_CODE),
                )
                else -> error("Unknown relay synchronization work")
            }
        }.fold(
            onSuccess = { Result.success() },
            onFailure = { if (runAttemptCount < MAX_RETRIES) Result.retry() else Result.failure() },
        )
    }

    companion object {
        private const val KEY_KIND = "kind"
        private const val KEY_TOKEN = "token"
        private const val KEY_CALL_ID = "call_id"
        private const val KEY_EVENT_TYPE = "event_type"
        private const val KEY_CODE = "code"
        private const val KIND_PUSH_TOKEN = "push_token"
        private const val KIND_EVENT = "event"
        private const val MAX_RETRIES = 3

        private val networkConstraint = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        fun enqueuePushToken(context: Context, token: String) {
            if (token.isBlank()) return
            val work = OneTimeWorkRequestBuilder<RelaySyncWorker>()
                .setConstraints(networkConstraint)
                .setInputData(Data.Builder().putString(KEY_KIND, KIND_PUSH_TOKEN).putString(KEY_TOKEN, token).build())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("relay-push-token", ExistingWorkPolicy.REPLACE, work)
        }

        fun enqueueFailure(context: Context, callId: String, code: String) {
            if (callId.isBlank()) return
            val work = OneTimeWorkRequestBuilder<RelaySyncWorker>()
                .setConstraints(networkConstraint)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setInputData(
                    Data.Builder()
                        .putString(KEY_KIND, KIND_EVENT)
                        .putString(KEY_CALL_ID, callId)
                        .putString(KEY_EVENT_TYPE, "failed")
                        .putString(KEY_CODE, code)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                "relay-failure-$callId-$code",
                ExistingWorkPolicy.KEEP,
                work,
            )
        }
    }
}
