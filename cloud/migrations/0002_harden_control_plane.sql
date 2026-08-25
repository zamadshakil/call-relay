ALTER TABLE pairings ADD COLUMN created_by_device_id TEXT REFERENCES devices(id);
ALTER TABLE pairings ADD COLUMN confirmed_by_device_id TEXT REFERENCES devices(id);
ALTER TABLE pairings ADD COLUMN confirmed_at INTEGER;

ALTER TABLE call_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN last_event_id TEXT;
ALTER TABLE call_sessions ADD COLUMN request_id TEXT;

CREATE UNIQUE INDEX call_request_once
ON call_sessions(pairing_id, direction, request_id)
WHERE request_id IS NOT NULL;

ALTER TABLE call_events ADD COLUMN command_id TEXT;
CREATE UNIQUE INDEX call_event_command_once
ON call_events(call_id, command_id)
WHERE command_id IS NOT NULL;

CREATE TABLE push_outbox (
  id TEXT PRIMARY KEY,
  target_device_id TEXT NOT NULL REFERENCES devices(id),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX push_outbox_pending
ON push_outbox(queued_at, created_at);
