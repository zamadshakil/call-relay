PRAGMA foreign_keys = ON;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'browser', 'ios')),
  display_name TEXT NOT NULL,
  public_key_spki TEXT NOT NULL,
  fcm_token TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  device_a_id TEXT NOT NULL REFERENCES devices(id),
  device_b_id TEXT NOT NULL REFERENCES devices(id),
  secret_commitment TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (device_a_id <> device_b_id),
  UNIQUE (device_a_id, device_b_id)
);

CREATE TABLE call_sessions (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  android_device_id TEXT NOT NULL REFERENCES devices(id),
  peer_device_id TEXT NOT NULL REFERENCES devices(id),
  direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  state TEXT NOT NULL CHECK (state IN ('created', 'ringing_peer', 'accepted', 'dialing_sim', 'active', 'ending', 'ended', 'failed')),
  phone_number TEXT,
  relay_mode TEXT NOT NULL DEFAULT 'full_duplex' CHECK (relay_mode IN ('full_duplex', 'listen', 'talk')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  failure_code TEXT
);

CREATE UNIQUE INDEX one_open_call_per_android
ON call_sessions(android_device_id)
WHERE state NOT IN ('ended', 'failed');

CREATE TABLE call_events (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX call_events_by_call ON call_events(call_id, created_at);

CREATE TABLE request_nonces (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

CREATE INDEX request_nonces_created_at ON request_nonces(created_at);
