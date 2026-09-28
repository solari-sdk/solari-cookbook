// SPDX-License-Identifier: AGPL-3.0-only
// The published command is the host's own bin, bundled whole: every workspace
// package rides inside dist/bin.js, so an install pulls no dependency tree and
// nothing here resolves at install time.
import "@wsp/host/dist/bin.js";
