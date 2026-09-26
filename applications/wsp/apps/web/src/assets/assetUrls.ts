// SPDX-License-Identifier: AGPL-3.0-only
// The terminal ships a wasm core and a symbols font; both arrive through
// Vite's ?url imports, so these two probes stand in for them in the build.
import probeWasmUrl from "./probe.wasm?url";
import probeWoff2Url from "./probe.woff2?url";

export { probeWasmUrl, probeWoff2Url };
