PRAGMA foreign_keys = ON;

DROP INDEX one_peer_per_user;

CREATE UNIQUE INDEX one_browser_per_user
ON devices(user_id)
WHERE platform = 'browser' AND revoked_at IS NULL AND user_id IS NOT NULL;

CREATE UNIQUE INDEX one_ios_per_user
ON devices(user_id)
WHERE platform = 'ios' AND revoked_at IS NULL AND user_id IS NOT NULL;

DROP TRIGGER pairings_one_active_insert;
DROP TRIGGER pairings_one_active_update;

-- A peer belongs to one active Android pairing, while the Android relay may
-- keep one independent encrypted pairing with each supported peer platform.
CREATE TRIGGER pairings_peer_one_active_insert
BEFORE INSERT ON pairings
WHEN NEW.revoked_at IS NULL AND EXISTS (
  SELECT 1
  FROM pairings p
  WHERE p.revoked_at IS NULL
    AND (
      ((p.device_a_id = NEW.device_a_id OR p.device_b_id = NEW.device_a_id)
        AND (SELECT platform FROM devices WHERE id = NEW.device_a_id) <> 'android')
      OR
      ((p.device_a_id = NEW.device_b_id OR p.device_b_id = NEW.device_b_id)
        AND (SELECT platform FROM devices WHERE id = NEW.device_b_id) <> 'android')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a peer already has an active pairing');
END;

CREATE TRIGGER pairings_peer_one_active_update
BEFORE UPDATE OF device_a_id, device_b_id, revoked_at ON pairings
WHEN NEW.revoked_at IS NULL AND EXISTS (
  SELECT 1
  FROM pairings p
  WHERE p.id <> NEW.id
    AND p.revoked_at IS NULL
    AND (
      ((p.device_a_id = NEW.device_a_id OR p.device_b_id = NEW.device_a_id)
        AND (SELECT platform FROM devices WHERE id = NEW.device_a_id) <> 'android')
      OR
      ((p.device_a_id = NEW.device_b_id OR p.device_b_id = NEW.device_b_id)
        AND (SELECT platform FROM devices WHERE id = NEW.device_b_id) <> 'android')
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a peer already has an active pairing');
END;

ALTER TABLE call_sessions ADD COLUMN selected_pairing_id TEXT REFERENCES pairings(id);
ALTER TABLE call_sessions ADD COLUMN selected_peer_device_id TEXT REFERENCES devices(id);

UPDATE call_sessions
SET selected_pairing_id = pairing_id,
    selected_peer_device_id = peer_device_id;

CREATE TABLE call_recipients (
  call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  peer_device_id TEXT NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL CHECK (status IN ('ringing', 'selected', 'declined', 'answered_elsewhere', 'missed')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER,
  decision_command_id TEXT,
  PRIMARY KEY (call_id, pairing_id),
  UNIQUE (call_id, peer_device_id)
);

CREATE INDEX call_recipients_by_peer
ON call_recipients(peer_device_id, status, created_at);

INSERT INTO call_recipients(call_id, pairing_id, peer_device_id, status, created_at, responded_at)
SELECT id, pairing_id, peer_device_id, 'selected', created_at, peer_accepted_at
FROM call_sessions;

CREATE UNIQUE INDEX call_request_once_per_android
ON call_sessions(android_device_id, direction, request_id)
WHERE request_id IS NOT NULL;
