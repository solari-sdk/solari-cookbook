# Portable investigation format

Portable investigations use the project-owned `solari-portable-case` JSON contract. Encrypted exports conventionally use the `.solari-case` extension but remain JSON containers so they can be inspected by third-party tooling without proprietary archive libraries.

Version 2 contains `case`, `events`, `entities`, `relationships`, `evidence`, `provenance`, and `saved_views` sections plus a manifest. The manifest records schema version, tool version, creation time, source identifiers, required capabilities, and SHA-256 checksums for the logical JSON members. Import verifies those checksums before local state mutation. Version 1 remains readable as a legacy format but cannot claim manifest-integrity verification.

Encrypted bundles wrap the portable case with AES-256-GCM ciphertext. The key is derived from a user passphrase with PBKDF2-HMAC-SHA-256 and a random salt; the IV is random per export. Neither the passphrase nor provider/API credentials are written to the bundle.

Before export and import, the console scans object keys and common credential-value patterns for secret/session material. Findings block the operation rather than serializing a suspected credential. Import is size-limited to 25 MiB and collection counts are bounded. An import is previewed before mutation, including schema/integrity status, object counts, source IDs, and duplicate/newer/older event conflicts. The user can merge using deterministic newer-record preference or open the case in isolated read-only mode without writing it to local storage.

CSV, GeoJSON, and GraphML derivative exports can be produced from the same portable investigation state. The format intentionally avoids executable content: imported source data is treated as data, not script.
