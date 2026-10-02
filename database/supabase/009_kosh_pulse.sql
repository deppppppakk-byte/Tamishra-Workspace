-- Kosh Pulse: incident decisions and signal acknowledgements.

CREATE TABLE IF NOT EXISTS kosh_pulse_incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  owner_user_id TEXT,
  owner_name TEXT,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CHECK(severity IN ('low','medium','high','critical')),
  CHECK(status IN ('open','investigating','mitigating','resolved'))
);

CREATE INDEX IF NOT EXISTS kosh_pulse_incidents_status_idx
ON kosh_pulse_incidents(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS kosh_pulse_acknowledgements (
  id TEXT PRIMARY KEY,
  signal_key TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  acknowledged_by_user_id TEXT NOT NULL,
  acknowledged_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS kosh_pulse_ack_expiry_idx
ON kosh_pulse_acknowledgements(expires_at);
