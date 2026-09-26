// SPDX-License-Identifier: AGPL-3.0-only
// The environment every test project runs its processes with. A test says the
// environment it means by handing one in; this is the belt behind that, so a
// developer or a builder who exports either variable reads the same result as
// one who does not. Read by all three projects (the node one in
// vitest.workspace.ts, apps/web and apps/www) so the fact has one home.
//
// It is the process environment this empties, not every spelling of a read: a
// test that aliases or spreads process.env is caught here rather than by the
// grep in packages/protocol/test/test-env.test.ts, which is deliberate.
import { LABS_ENV, PERSON_HOME_ENV, TURN_TOKEN_ENV, UPDATE_CHECK_ENV } from "./packages/protocol/src/env.js";

// The release check is off, so no host a test starts asks GitHub for the newest release.
export const TEST_ENV: Record<string, string> = { [LABS_ENV]: "", [PERSON_HOME_ENV]: "", [TURN_TOKEN_ENV]: "", [UPDATE_CHECK_ENV]: "0" };
