PRAGMA foreign_keys = ON;

CREATE TABLE approved_emails (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'suspended')),
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE firebase_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  photo_url TEXT,
  email_verified INTEGER NOT NULL CHECK (email_verified IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_authenticated_at INTEGER NOT NULL
);

CREATE TABLE billing_subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES firebase_users(id) ON DELETE CASCADE,
  paddle_customer_id TEXT UNIQUE,
  paddle_subscription_id TEXT UNIQUE,
  plan_code TEXT CHECK (plan_code IS NULL OR plan_code IN ('monthly', 'annual')),
  status TEXT NOT NULL DEFAULT 'none' CHECK (
    status IN ('none', 'pending', 'active', 'past_due', 'paused', 'canceled', 'refunded', 'disputed')
  ),
  current_period_ends_at INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  latest_transaction_id TEXT,
  source_occurred_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE billing_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  processed_at INTEGER NOT NULL
);

CREATE INDEX billing_webhook_events_processed
ON billing_webhook_events(processed_at);

ALTER TABLE devices ADD COLUMN user_id TEXT REFERENCES firebase_users(id);
ALTER TABLE devices ADD COLUMN agreement_public_key_raw TEXT;
ALTER TABLE devices ADD COLUMN app_version INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX one_android_per_user
ON devices(user_id)
WHERE platform = 'android' AND revoked_at IS NULL AND user_id IS NOT NULL;

CREATE UNIQUE INDEX one_peer_per_user
ON devices(user_id)
WHERE platform IN ('browser', 'ios') AND revoked_at IS NULL AND user_id IS NOT NULL;

CREATE TABLE sim_profiles (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  slot_index INTEGER NOT NULL CHECK (slot_index >= 0 AND slot_index <= 8),
  carrier_name TEXT NOT NULL,
  country_iso TEXT NOT NULL CHECK (length(country_iso) = 2),
  number_source TEXT NOT NULL CHECK (number_source IN ('subscription', 'user_confirmed', 'unavailable')),
  phone_number_ciphertext TEXT,
  phone_number_iv TEXT,
  phone_number_last4 TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pairing_invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES firebase_users(id) ON DELETE CASCADE,
  android_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  challenge_hash TEXT NOT NULL,
  peer_device_id TEXT REFERENCES devices(id),
  peer_public_key_raw TEXT,
  peer_commitment TEXT,
  peer_proof TEXT,
  pairing_id TEXT REFERENCES pairings(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  confirmed_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX pairing_invitations_android_active
ON pairing_invitations(android_device_id, expires_at)
WHERE consumed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE pairings ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2));
ALTER TABLE pairings ADD COLUMN user_id TEXT REFERENCES firebase_users(id);
ALTER TABLE pairings ADD COLUMN invitation_id TEXT REFERENCES pairing_invitations(id);
ALTER TABLE pairings ADD COLUMN peer_proof TEXT;
ALTER TABLE pairings ADD COLUMN android_proof TEXT;
