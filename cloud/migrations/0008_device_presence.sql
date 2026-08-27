PRAGMA foreign_keys = ON;

CREATE TABLE device_presence (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  service_instance_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  relay_ready INTEGER NOT NULL CHECK (relay_ready IN (0, 1)),
  signal_state TEXT NOT NULL CHECK (signal_state IN ('connecting', 'connected', 'disconnected')),
  active_call_id TEXT REFERENCES call_sessions(id) ON DELETE SET NULL,
  process_started_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX device_presence_freshness
ON device_presence(last_heartbeat_at);

CREATE TABLE pairing_control_outbox (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairings(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action = 'revoke'),
  reason TEXT NOT NULL CHECK (reason IN ('device_replaced', 'device_revoked', 'pairing_replaced', 'manual')),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (pairing_id, action)
);

CREATE INDEX pairing_control_outbox_pending
ON pairing_control_outbox(created_at)
WHERE delivered_at IS NULL;
