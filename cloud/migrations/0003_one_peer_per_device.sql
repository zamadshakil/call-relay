CREATE TRIGGER pairings_one_active_insert
BEFORE INSERT ON pairings
WHEN NEW.revoked_at IS NULL AND EXISTS (
  SELECT 1 FROM pairings
  WHERE revoked_at IS NULL
    AND (
      device_a_id IN (NEW.device_a_id, NEW.device_b_id)
      OR device_b_id IN (NEW.device_a_id, NEW.device_b_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a device already has an active pairing');
END;

CREATE TRIGGER pairings_one_active_update
BEFORE UPDATE OF device_a_id, device_b_id, revoked_at ON pairings
WHEN NEW.revoked_at IS NULL AND EXISTS (
  SELECT 1 FROM pairings
  WHERE id <> NEW.id
    AND revoked_at IS NULL
    AND (
      device_a_id IN (NEW.device_a_id, NEW.device_b_id)
      OR device_b_id IN (NEW.device_a_id, NEW.device_b_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'a device already has an active pairing');
END;
