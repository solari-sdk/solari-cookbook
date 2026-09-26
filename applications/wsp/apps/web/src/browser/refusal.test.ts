// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { explainRefusal } from "./refusal.js";

const HOST = "d1f292946d3bf9229dff-5173.preview.getsolari.com";
const at = { port: 5173, host: HOST };

describe("explainRefusal", () => {
  it("names Vite's host check from the measured 403 body, says both fixes and replaces the frame", () => {
    const body = `Blocked request. This host (${HOST}) is not allowed. To allow this host, add it to server.allowedHosts`;
    const refusal = explainRefusal({ status: 403, body }, at);
    expect(refusal?.title).toBe(":5173 refused the preview host");
    expect(refusal?.detail).toContain("Vite");
    expect(refusal?.detail).toContain(HOST);
    expect(refusal?.detail).toContain("Restart the dev server");
    expect(refusal?.detail).toContain("server.allowedHosts");
    expect(refusal?.keepsFrame).toBe(false);
  });

  it("reads Vite's newer body too, with the host quoted and the fix on its own line", () => {
    const body = `Blocked request. This host ("${HOST}") is not allowed.\nTo allow this host, add "${HOST}" to \`server.allowedHosts\` in vite.config.js.`;
    expect(explainRefusal({ status: 403, body }, at)?.detail).toContain("Vite");
  });

  it("names webpack-dev-server's allowedHosts from its exact Invalid Host header body", () => {
    const refusal = explainRefusal({ status: 403, body: "Invalid Host header" }, { port: 8080, host: HOST });
    expect(refusal?.title).toBe(":8080 refused the preview host");
    expect(refusal?.detail).toContain("webpack-dev-server");
    expect(refusal?.detail).toContain(HOST);
    expect(refusal?.detail).toContain("allowedHosts");
    expect(refusal?.keepsFrame).toBe(false);
  });

  it("names Rails' config.hosts from its HostAuthorization page", () => {
    const body = `<!DOCTYPE html><html><head><title>Action Controller: Exception caught</title></head><body><header><h1>Blocked hosts: ${HOST}</h1></header><div id="container"><h2>To allow requests to ${HOST}, add the following to your environment configuration:</h2><pre>config.hosts &lt;&lt; "${HOST}"</pre></div></body></html>`;
    const refusal = explainRefusal({ status: 403, body }, { port: 3000, host: HOST });
    expect(refusal?.title).toBe(":3000 refused the preview host");
    expect(refusal?.detail).toContain("Rails");
    expect(refusal?.detail).toContain(HOST);
    expect(refusal?.detail).toContain("config.hosts");
    expect(refusal?.keepsFrame).toBe(false);
  });

  it("offers Next's allowedDevOrigins for a bare 403 Unauthorized, hedged since any server can write that body", () => {
    const refusal = explainRefusal({ status: 403, body: "Unauthorized" }, { port: 3000, host: HOST });
    expect(refusal?.title).toBe(":3000 refused the preview host");
    expect(refusal?.detail).toMatch(/^If this is Next\.js/);
    expect(refusal?.detail).toContain("allowedDevOrigins");
    expect(refusal?.detail).toContain("next.config");
    expect(refusal?.keepsFrame).toBe(false);
  });

  it("keeps the frame for any other 403 and explains it as a hint without guessing the server", () => {
    const refusal = explainRefusal({ status: 403, body: "<html>Forbidden</html>" }, at);
    expect(refusal?.title).toBe(":5173 answered 403 through the preview route");
    expect(refusal?.detail).toContain(HOST);
    expect(refusal?.detail).not.toContain("Vite");
    expect(refusal?.detail).not.toContain("Next");
    expect(refusal?.keepsFrame).toBe(true);
  });

  it("keeps the frame on a 401 and says the token was already reminted once", () => {
    const refusal = explainRefusal({ status: 401, body: "" }, at);
    expect(refusal?.title).toBe(":5173 answered 401 through the preview route");
    expect(refusal?.detail).toMatch(/fresh token/);
    expect(refusal?.keepsFrame).toBe(true);
  });

  it("leaves every other answer to the frame", () => {
    expect(explainRefusal({ status: 200, body: "<!doctype html>" }, at)).toBeNull();
    expect(explainRefusal({ status: 302, body: "" }, at)).toBeNull();
    expect(explainRefusal({ status: 404, body: "Not found" }, at)).toBeNull();
    expect(explainRefusal({ status: 500, body: "boom" }, at)).toBeNull();
    expect(explainRefusal({ status: 502, body: "" }, at)).toBeNull();
  });
});
