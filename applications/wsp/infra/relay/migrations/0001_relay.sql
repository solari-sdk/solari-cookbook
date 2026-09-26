-- SPDX-License-Identifier: AGPL-3.0-only
-- The whole of what the relay keeps: who a person is, which boxes they own,
-- and the codes a box is waiting on. No device token and no pairing code has
-- a column here, and none ever will: pairing is between the person's client
-- and their own host, and the relay is only the directory that says where
-- that host answers.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  login TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX accounts_provider ON accounts (provider, provider_id);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hostname TEXT,
  tunnel_id TEXT,
  connector_version TEXT,
  created_at TEXT NOT NULL,
  last_seen TEXT
);
CREATE INDEX hosts_account ON hosts (account_id);

-- One row per computer a person signed in from, so a token that walked off can
-- be taken away without rotating the key every box on the relay depends on.
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT
);
CREATE INDEX clients_account ON clients (account_id);

CREATE TABLE link_codes (
  code TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  account_id TEXT,
  host_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX link_codes_poll ON link_codes (poll_hash);
