ALTER TABLE devices ADD COLUMN fcm_target_kind TEXT NOT NULL DEFAULT 'token'
  CHECK (fcm_target_kind IN ('token', 'fid'));
