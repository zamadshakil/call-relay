ALTER TABLE call_sessions ADD COLUMN media_transport TEXT NOT NULL DEFAULT 'webrtc_p2p'
  CHECK (media_transport = 'webrtc_p2p');
ALTER TABLE call_sessions ADD COLUMN ice_policy TEXT NOT NULL DEFAULT 'all'
  CHECK (ice_policy IN ('all', 'relay'));
ALTER TABLE call_sessions ADD COLUMN media_connected_at INTEGER;
ALTER TABLE call_sessions ADD COLUMN media_failure_code TEXT;
ALTER TABLE call_sessions ADD COLUMN selected_candidate_type TEXT
  CHECK (selected_candidate_type IS NULL OR selected_candidate_type IN ('host', 'srflx', 'relay'));

CREATE TABLE turn_credentials (
  username TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  custom_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX turn_credentials_by_call
ON turn_credentials(call_id, revoked_at, expires_at);
