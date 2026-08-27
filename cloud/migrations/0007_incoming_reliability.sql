ALTER TABLE call_sessions ADD COLUMN peer_accepted_at INTEGER;
ALTER TABLE call_sessions ADD COLUMN telecom_answer_requested_at INTEGER;
ALTER TABLE call_sessions ADD COLUMN sim_active_at INTEGER;

ALTER TABLE push_outbox ADD COLUMN channel TEXT NOT NULL DEFAULT 'android_fcm'
  CHECK (channel IN ('android_fcm', 'web_push'));
ALTER TABLE push_outbox ADD COLUMN provider_accepted_at INTEGER;
ALTER TABLE push_outbox ADD COLUMN provider_message_id TEXT;

CREATE TABLE web_push_subscriptions (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  endpoint_hash TEXT NOT NULL UNIQUE,
  subscription_ciphertext TEXT NOT NULL,
  subscription_iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX web_push_subscriptions_endpoint_hash_idx
  ON web_push_subscriptions(endpoint_hash);
