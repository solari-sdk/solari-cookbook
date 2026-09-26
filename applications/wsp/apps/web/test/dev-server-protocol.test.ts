// SPDX-License-Identifier: AGPL-3.0-only
// The render tests spawn this dev server in a fresh worktree, which has no
// built @wsp/protocol dist; the server must serve the package from source or
// the browser page never renders and the test dies at its timeout instead.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startVite, stopVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Vite answers a failed transform with an HTML error page whose script holds the error as JSON.
const cause = (body: string): string => {
  const json = /const error = (\{.*\})/.exec(body)?.[1];
  return json === undefined ? body : String((JSON.parse(json) as { message: string }).message);
};

let vite: ViteChild | undefined;

beforeAll(async () => {
  vite = await startVite(WEB_DIR, "/test/shell/index.html");
}, 60_000);

afterAll(() => stopVite(vite?.child));

it("the dev server serves @wsp/protocol from source, so a worktree needs no dist", async () => {
  const response = await fetch(`${vite!.base}/src/shell/signInStore.ts`);
  const body = await response.text();
  expect(response.status, cause(body)).toBe(200);
  expect(body).toContain("/packages/protocol/src/index.ts");
}, 30_000);
