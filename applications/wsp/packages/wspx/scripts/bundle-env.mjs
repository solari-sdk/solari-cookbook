// SPDX-License-Identifier: AGPL-3.0-only
// node scripts/bundle-env.mjs 1.2.3: the release job's asset names as the
// lines a step appends to $GITHUB_ENV, so the workflow spells none of them.
import { bundleEnv } from "./bundles.mjs";

process.stdout.write(bundleEnv(process.argv[2] ?? ""));
