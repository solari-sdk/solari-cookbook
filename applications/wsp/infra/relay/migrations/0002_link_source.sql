-- SPDX-License-Identifier: AGPL-3.0-only
-- Where a link code was started from, so one caller cannot grow this table
-- without end, and the index the sweep of dead codes reads.

ALTER TABLE link_codes ADD COLUMN source TEXT NOT NULL DEFAULT '';
CREATE INDEX link_codes_expires ON link_codes (expires_at);
