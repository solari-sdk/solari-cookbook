// SPDX-License-Identifier: AGPL-3.0-only
// One spelling of a key's fingerprint for everything here that names a key to a
// person: the machine key an ssh dial answered with, and the key a host proves
// at a join. It lives with the rest of a link's cryptography, which the command
// line reads without loading this package.
export { keyFingerprint } from "@wsp/keys";
