-- SPDX-License-Identifier: AGPL-3.0-only
-- The keys the account's computers and boxes prove, and the admissions that let
-- a computer onto a box. A fingerprint is the hash of a public key and opens
-- nothing. An admission is bytes a computer the box already trusts signed:
-- this relay stores them and hands them to the box, verifies none of them and
-- holds no key that could make one. Still no device token, no pairing code, no
-- host token and no private key has a column here.

ALTER TABLE link_codes ADD COLUMN fingerprint TEXT;
ALTER TABLE link_codes ADD COLUMN admission TEXT;
ALTER TABLE clients ADD COLUMN fingerprint TEXT;
-- A key is one computer's on an account, as a name is one box's. SQLite keeps
-- nulls distinct under a unique index, so the computers signed in before device
-- keys collide with nothing.
CREATE UNIQUE INDEX clients_account_key ON clients (account_id, fingerprint);
ALTER TABLE hosts ADD COLUMN host_key TEXT;

CREATE TABLE admissions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  signer TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX admissions_client_signer ON admissions (client_id, signer);
CREATE INDEX admissions_account ON admissions (account_id);
