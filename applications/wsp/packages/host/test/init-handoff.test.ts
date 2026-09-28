// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in hand-off over a scripted daemon link: the page the tool printed,
// the code beside it and the command that opens it are said once and printed as
// JSON, the tool's own status is asked on the machine until the person is
// through, and a deadline that passes ends the row instead of the run.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
import { SIGN_IN_DEFERRED_WORD, initRowFailed, initSignInOutcome } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { CALLBACK_DISPLAY, cadence, codeIn, handoffStage, rowFinish, signInEnv, type HandoffOptions } from "../src/init-handoff.js";
import { SIGN_IN_CAP_MS, SignInCodes, flowHooks, type SignInFlow } from "../src/init-signin.js";
import { signInFor } from "../src/signin-table.js";
import { fakePtyLink, type FakePty, type FakePtyLink } from "./fake-pty-link.js";
import { ASKED, loginOf } from "./signin-questions.js";

const GH: ManifestEntry = { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "machine" };
const CLAUDE: ManifestEntry = { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: [], bytes: 0, default: "bring", choice: "copy" };
const KUBE: ManifestEntry = { rung: "logins", id: "logins/kube", label: "kubeconfig", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "machine" };
const GCLOUD: ManifestEntry = { rung: "logins", id: "logins/gcloud", label: "Google Cloud login", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "machine" };
const DEVICE = "https://github.com/login/device";
const CODE = "8F4A-C21B";
/** gcloud's own two pages (client id cut, state and challenge placeholders): with a browser to reach it redirects to
 * a port on the machine, and with none it redirects to the page that shows a code to paste. */
const GCLOUD_PAGE =
  "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&scope=openid+email&state=S&code_challenge=C&code_challenge_method=S256";
const GCLOUD_PASTE =
  "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2FauthCode.html&scope=openid+email&state=S&code_challenge=C&code_challenge_method=S256";
/** aws sso's page: its redirect comes back to the machine without naming a port, which its listener gives later. */
const AWS_BARE = "https://d-1234.awsapps.com/start/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%2Foauth%2Fcallback&state=S";
/** Shaped like a Google authorization code; nothing real. */
const PASTED = "4/0AfakeCodeFromThePage";
/** The page the machine asks the host to open, which returns through the forwarded port. */
const PAGE = "https://github.com/login/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A42485%2Fcallback";
const BANNER = "https://cli.github.com/upgrade";
const BUILDER = { id: "m_builder", name: "default" };
const GH_LOGIN = loginOf("gh");
const AWS: ManifestEntry = { rung: "logins", id: "logins/aws", label: "AWS SSO login", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "machine" };
const DOPPLER: ManifestEntry = { rung: "logins", id: "logins/doppler", label: "Doppler login", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "machine" };
const DOPPLER_PAGE = "https://dashboard.doppler.com/workplace/auth/cli";
const GH_CODE = (() => {
  const s = signInFor("gh");
  return s.kind === "device" ? s.code : undefined;
})();

function stage(link: FakePtyLink, over: Partial<HandoffOptions> = {}) {
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const json: Record<string, unknown>[] = [];
  const run = handoffStage({
    logins: [GH],
    dial: async () => ({ link: link.dial(), close: () => {} }),
    output,
    json: record => json.push(record),
    platform: "darwin",
    pollMs: 5,
    graceMs: 5,
    deadlineMs: 2_000,
    ...over,
  });
  return { run, json, text: () => stripVTControlCharacters(chunks.join("")) };
}

/** gh's device flow on a builder: the code and its page, the login command then blocking on the person. The
 * status command answers not-signed-in until `after` checks have been made. */
function ghLink(o: { after: number; hold?: boolean; exitCode?: number }): FakePtyLink {
  const link = fakePtyLink();
  let checks = 0;
  link.script = (pty: FakePty, line: string) => {
    if (line.includes("WSP_STATUS")) {
      checks += 1;
      const on = checks > o.after;
      link.data(pty, `${on ? "github.com\n  ✓ Logged in to github.com account Zingzy" : "You are not logged into any GitHub hosts"}\r\nWSP_STATUS ${on ? 0 : 1}\r\n`);
      link.exit(pty, 0);
      return;
    }
    link.data(pty, `! First copy your one-time code: ${CODE}\r\nOpen this page to continue: ${DEVICE}\r\nWaiting for you to sign in...\r\n`);
    if (o.hold !== true) link.exit(pty, o.exitCode ?? 0);
  };
  return link;
}

describe("the code beside a page", () => {
  it("reads a device code in the shape the row names, never out of the page's own query string, and nothing at all for a row with no shape", () => {
    expect(GH_CODE).toBeInstanceOf(RegExp);
    expect(codeIn(`! First copy your one-time code: ${CODE}\nOpen ${DEVICE}`, GH_CODE)).toBe(CODE);
    expect(codeIn(`visit: https://claude.com/oauth/authorize?state=ABCD-1234&code=true\nPaste code here > `, GH_CODE)).toBeUndefined();
    expect(codeIn(`Opening ${DEVICE} in your browser`, GH_CODE)).toBeUndefined();
    // claude's row shows no code, so a token of that shape in its output is never announced as one.
    expect(codeIn(`! First copy your one-time code: ${CODE}`, undefined)).toBeUndefined();
  });
});

describe("the road a login's row is on", () => {
  it("is read off the page the tool asked for: a redirect back to the machine is the callback road, a page that hands something back takes a code", () => {
    // gcloud's two pages, whatever the forward is doing: the road is in the URL, so no row asks for a code it will not need.
    expect(rowFinish("callback", GCLOUD_PAGE)).toBe("callback");
    expect(rowFinish("callback", GCLOUD_PASTE)).toBe("code");
    expect(rowFinish("callback", DEVICE)).toBe("code");
    // aws registers its callback on 127.0.0.1 with no port and binds one at the time: the page still comes back.
    expect(rowFinish("callback", AWS_BARE)).toBe("callback");
    expect(rowFinish("code", GCLOUD_PAGE)).toBe("code");
    expect(rowFinish("none", GCLOUD_PASTE)).toBe("none");
    expect(rowFinish("none", GCLOUD_PAGE)).toBe("none");
    // Only the callback road hands the tool a browser to find; the others take the pty as it comes.
    expect(signInEnv("callback")).toEqual({ DISPLAY: CALLBACK_DISPLAY });
    expect(signInEnv("code")).toBeUndefined();
    expect(signInEnv("none")).toBeUndefined();
  });
});

describe("how often the status is asked", () => {
  it("every pollMs for the first minute, then every twenty seconds or the caller's slower cadence", () => {
    expect(cadence(0, 5_000)).toBe(5_000);
    expect(cadence(59_999, 5_000)).toBe(5_000);
    expect(cadence(60_000, 5_000)).toBe(20_000);
    expect(cadence(15 * 60_000, 5_000)).toBe(20_000);
    expect(cadence(60_000, 30_000)).toBe(30_000);
  });
});

describe("the sign-in hand-off", () => {
  it("prints the page, the code and the command that opens it once, then signs the row in on the check that says so", async () => {
    const link = ghLink({ after: 1, hold: true });
    const st = stage(link);
    const [r] = await st.run;
    expect(r).toMatchObject({ id: "logins/gh", state: "signed-in", command: GH_LOGIN, note: "gh auth status says signed in" });
    expect(st.json).toEqual([
      // The row stands as the command starts, before the tool has printed its page and before any road is known.
      { event: "sign-in", tool: "gh", label: "GitHub CLI login" },
      { event: "sign-in", tool: "gh", label: "GitHub CLI login", browserUrl: DEVICE, code: CODE, finish: "none", nextCommand: `open '${DEVICE}'`, waitSeconds: 2 },
      { event: "sign-in-result", tool: "gh", label: "GitHub CLI login", state: "signed-in", note: "gh auth status says signed in" },
    ]);
    const text = st.text();
    expect(text).toContain(`GitHub CLI login: open ${DEVICE} on this computer, then enter the code ${CODE}`);
    expect(text).toContain(`open '${DEVICE}'`);
    expect(text).toContain(`${GH_LOGIN} is running on the machine; this run waits up to 2.0s for you`);
    expect(text).toContain("GitHub CLI login: signed in");
    // Two checks: the first said no, the second said yes, and the login's own pty was killed once it had.
    expect(link.ptys.filter(p => p.writes[0]?.includes("WSP_STATUS"))).toHaveLength(2);
    expect(link.ptys[0]!.ran).toBe(GH_LOGIN);
    expect(link.ptys.every(p => p.killed)).toBe(true);
  });

  it("on the platform's own opener: linux hands over xdg-open", async () => {
    const st = stage(ghLink({ after: 0, hold: true }), { platform: "linux" });
    await st.run;
    expect(st.json[1]).toMatchObject({ nextCommand: `xdg-open '${DEVICE}'` });
  });

  it("a status that says signed in gives the command a moment to end on its own before its pty is killed", async () => {
    const link = fakePtyLink();
    let login: FakePty | undefined;
    link.script = (pty, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(pty, `github.com\n  ✓ Logged in to github.com account Zingzy\r\nWSP_STATUS 0\r\n`);
        link.exit(pty, 0);
        // gh writes its git protocol and credential helper after the status already says logged in.
        setTimeout(() => link.exit(login!, 0), 20);
        return;
      }
      login = pty;
      link.data(pty, `! First copy your one-time code: ${CODE}\r\nOpen this page to continue: ${DEVICE}\r\n`);
    };
    const st = stage(link, { graceMs: 500 });
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "signed-in", exit: 0, note: "gh auth status says signed in" });
  });

  it("the cap that passes defers the row with what the last check said, and the run goes on", async () => {
    const link = ghLink({ after: 99, hold: true });
    const st = stage(link, { deadlineMs: 60, pollMs: 10 });
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "deferred", note: "no sign-in within 60ms; gh auth status says not signed in" });
    expect(r).not.toHaveProperty("exit");
    expect(st.json.at(-1)).toMatchObject({ event: "sign-in-result", state: "deferred" });
    expect(st.text()).toContain(`GitHub CLI login: ${SIGN_IN_DEFERRED_WORD}`);
    expect(link.ptys[0]!.killed).toBe(true);
    // The stage ended, so the build goes on to the seal, and the row is no failure: the person chose to wait during
    // the build and the wait ended.
    expect(initRowFailed(initSignInOutcome(r!.state, "darwin"))).toBe(false);
  });

  it("gives every sign-in the same two minutes, whatever the tool itself would wait for", async () => {
    expect(SIGN_IN_CAP_MS).toBe(2 * 60_000);
    // No deadline of the caller's: the cap is the whole wait, and the row says so before anyone opens the page.
    const link = ghLink({ after: 99, hold: true });
    const st = stage(link, { deadlineMs: undefined, pollMs: 5 });
    for (let i = 0; i < 200 && !st.json.some(j => j["browserUrl"] !== undefined); i++) await new Promise(r => setTimeout(r, 5));
    expect(st.json.find(j => j["browserUrl"] !== undefined)).toMatchObject({ waitSeconds: 120 });
    expect(st.text()).toContain("this run waits up to 2m for you");
    link.exit(link.ptys[0]!, 0);
    await st.run;
  });

  it("a command that ends 0 by itself is signed in without another check; one that ends badly is judged by the tool's status", async () => {
    const clean = stage(ghLink({ after: 99 }));
    expect((await clean.run)[0]).toMatchObject({ state: "signed-in", exit: 0, note: `${GH_LOGIN} exited 0` });

    const refused = stage(ghLink({ after: 99, exitCode: 1 }));
    expect((await refused.run)[0]).toMatchObject({ state: "not-signed-in", exit: 1, note: `${GH_LOGIN} exited 1; gh auth status says not signed in` });

    const late = stage(ghLink({ after: 0, exitCode: 1 }));
    expect((await late.run)[0]).toMatchObject({ state: "signed-in", exit: 1, note: "gh auth status says signed in" });
  });

  it("answers the question the row says its tool waits on, on that tool's own pty, so the flow reaches the browser with nobody at the machine", async () => {
    const link = fakePtyLink();
    let login: FakePty | undefined;
    link.script = (pty, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(pty, `You are not logged into any GitHub hosts\r\nWSP_STATUS 1\r\n`);
        link.exit(pty, 0);
        return;
      }
      if (!line.includes("; exec bash -c ")) return;
      login = pty;
      link.data(pty, ASKED.ghWeb.replace(/\n/g, "\r\n"));
    };
    const st = stage(link, { deadlineMs: 120, pollMs: 20 });
    await st.run;
    // The command line, then the Enter gh waits on before it opens anything; nothing else is ever typed at it.
    expect(login!.ran).toBe(GH_LOGIN);
    expect(login!.writes.slice(1)).toEqual(["\r"]);
    // The code and the page gh printed beside that question still reach the person.
    expect(st.json[1]).toMatchObject({ browserUrl: DEVICE, code: "72F3-072B" });
  });

  it("ends a row at a question only the person can answer, in the tool's own words, instead of waiting out the cap", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(pty, `\r\nWSP_STATUS 1\r\n`);
        link.exit(pty, 0);
        return;
      }
      if (!line.includes("; exec bash -c ")) return;
      link.data(pty, `${ASKED.awsSso}`);
    };
    const started = Date.now();
    const st = stage(link, { logins: [AWS], deadlineMs: 10_000, pollMs: 2_000 });
    const [r] = await st.run;
    // The row is settled long before the cap, and its note names the question rather than the wait.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toMatchObject({ state: "not-signed-in", note: `${loginOf("aws")} asks "SSO session name (Recommended)", which only you can answer; sign in from the app's terminal` });
    expect(st.text()).not.toContain("no sign-in within");
    expect(st.json.at(-1)).toMatchObject({ event: "sign-in-result", state: "not-signed-in" });
    expect(link.ptys[0]!.killed).toBe(true);
    // Nothing was typed at it: the answer is the person's and no guess belongs on their terminal.
    expect(link.ptys[0]!.ran).toBe(loginOf("aws"));
    expect(link.ptys[0]!.writes).toHaveLength(1);
  });

  it("says the page again when the code lands after it, so a row whose tool prints them in that order still shows both", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(pty, `\r\nWSP_STATUS 1\r\n`);
        link.exit(pty, 0);
        return;
      }
      if (!line.includes("; exec bash -c ")) return;
      // doppler prints its page one line before its code, and the pty hands them over as two chunks.
      link.data(pty, "Complete authorization at https://dashboard.doppler.com/workplace/auth/cli\r\n");
      setTimeout(() => link.data(pty, "Your auth code is:\r\narugula_backpack_termite_sea_lannister\r\n\r\nWaiting...\r\n"), 5);
    };
    const st = stage(link, { logins: [DOPPLER], deadlineMs: 300, pollMs: 50 });
    await st.run;
    const pages = st.json.filter(j => j["browserUrl"] !== undefined);
    expect(pages).toEqual([
      { event: "sign-in", tool: "doppler", label: "Doppler login", browserUrl: DOPPLER_PAGE, finish: "none", nextCommand: `open '${DOPPLER_PAGE}'`, waitSeconds: 0 },
      { event: "sign-in", tool: "doppler", label: "Doppler login", browserUrl: DOPPLER_PAGE, code: "arugula_backpack_termite_sea_lannister", finish: "none", nextCommand: `open '${DOPPLER_PAGE}'`, waitSeconds: 0 },
    ]);
    expect(st.text()).toContain("then enter the code arugula_backpack_termite_sea_lannister");
  });

  it("a tool the shell cannot find is skipped with that reason and no status is asked", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (!line.includes("WSP_STATUS")) {
        link.data(pty, "bash: exec: gh: not found\r\n");
        link.exit(pty, 127);
      }
    };
    const st = stage(link);
    expect((await st.run)[0]).toMatchObject({ state: "skipped", exit: 127, note: "gh is not on the machine" });
    expect(link.ptys).toHaveLength(1);
    expect(st.json.at(-1)).toMatchObject({ state: "skipped", note: "gh is not on the machine" });
  });

  it("a copied login is recorded as copied and a login the catalog has no sign-in for is skipped with its own words: neither runs anything", async () => {
    const link = fakePtyLink();
    const st = stage(link, { logins: [CLAUDE, KUBE] });
    expect(await st.run).toEqual([
      { id: "logins/claude", label: "Claude Code login", state: "copied" },
      { id: "logins/kube", label: "kubeconfig", state: "skipped", note: "kubectl has no sign-in; copy the kubeconfig instead" },
    ]);
    expect(link.ptys).toEqual([]);
    // The copied login is a row of its own on the wire, settled before any page; the skipped one says why.
    expect(st.json).toEqual([
      { event: "sign-in-result", tool: "claude", label: "Claude Code login", state: "copied" },
      { event: "sign-in-result", tool: "kube", label: "kubeconfig", state: "skipped", note: "kubectl has no sign-in; copy the kubeconfig instead" },
    ]);
    expect(st.text()).toContain("Claude Code login: copied");
  });

  it("a later page replaces the one handed over, and the page the machine asks the host to open wins over anything printed", async () => {
    const link = fakePtyLink();
    let pty: FakePty | undefined;
    link.script = (p, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(p, `You are not logged into any GitHub hosts\r\nWSP_STATUS 1\r\n`);
        link.exit(p, 0);
        return;
      }
      pty = p;
      link.data(p, `A new release of gh is available: ${BANNER}\r\n`);
      link.data(p, `! First copy your one-time code: ${CODE}\r\nOpen this page to continue: ${DEVICE}\r\n`);
    };
    const flow: SignInFlow = { armed: false };
    const hooks = flowHooks(flow, BUILDER);
    const st = stage(link, { flow, deadlineMs: 400, pollMs: 20 });
    for (let i = 0; i < 200 && pty === undefined; i++) await new Promise(r => setTimeout(r, 5));
    // The shim: the machine asks for its callback page, which is not opened here and comes to the stage instead.
    expect(hooks.autoOpen(BUILDER.id, PAGE, 42485)).toBe(false);
    const line = hooks.openLine("default (builder)", "github.com", PAGE);
    expect(hooks.onLine(line)).toBe(true);
    // A page printed after the forwarded one is not handed over: only the forwarded one returns to the machine.
    link.data(pty!, `If nothing happens, open ${DEVICE}?fallback=1 yourself\r\n`);
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "deferred" });
    expect(st.json.filter(j => j["event"] === "sign-in" && j["browserUrl"] !== undefined).map(j => j["browserUrl"])).toEqual([BANNER, DEVICE, PAGE]);
    expect(st.json.filter(j => j["event"] === "sign-in").at(-1)).toMatchObject({ code: CODE, nextCommand: `open '${PAGE}'` });
    // The relay's own line for that page reached this stage's output instead of the host's plain log.
    expect(st.text()).toContain("default (builder): its sign-in page is the one handed to you above");
    expect(flow).toEqual({ armed: false });
  });

  it("a login the tool never prints a page for says so, and the flow is left as it was found", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(pty, `You are not logged into any GitHub hosts\r\nWSP_STATUS 1\r\n`);
        link.exit(pty, 0);
        return;
      }
      link.data(pty, "? What account do you want to log into?\r\n");
    };
    const flow: SignInFlow = { armed: false };
    const st = stage(link, { flow, deadlineMs: 60, pollMs: 10 });
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "deferred", note: "no sign-in within 60ms; no page to open was ever printed or asked for; gh auth status says not signed in" });
    expect(st.json.some(j => j["event"] === "sign-in" && j["browserUrl"] !== undefined)).toBe(false);
    expect(flow).toEqual({ armed: false });
  });

  it("a daemon that refuses the pty ends the row at once with the reason, never at the deadline", async () => {
    const link = fakePtyLink();
    const real = link.op.bind(link);
    let creates = 0;
    link.op = async (name, extra = {}) => {
      if (name !== "pty.create") return real(name, extra);
      creates += 1;
      return { ok: false, error: "pty.create is not allowed here" };
    };
    const st = stage(link, { deadlineMs: 30_000, pollMs: 10_000 });
    const t0 = Date.now();
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "not-signed-in", note: "pty.create refused: pty.create is not allowed here" });
    expect(Date.now() - t0).toBeLessThan(5_000);
    // The login's pty alone was asked for: a status check on a login that never ran answers nothing.
    expect(creates).toBe(1);
  });

  it("a login whose row finishes by callback runs with a browser to reach, and the page that returns through the forwarded port is handed over with no code beside it", async () => {
    const link = fakePtyLink();
    let pty: FakePty | undefined;
    link.script = (p, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(p, `someone@example.com\r\nWSP_STATUS 0\r\n`);
        link.exit(p, 0);
        return;
      }
      pty = p;
      link.data(p, `Your browser has been opened to visit:\r\n\r\n    ${GCLOUD_PAGE}\r\n\r\n`);
    };
    const flow: SignInFlow = { armed: false };
    const hooks = flowHooks(flow, BUILDER);
    const st = stage(link, { logins: [GCLOUD], flow, deadlineMs: 1_000, pollMs: 20 });
    for (let i = 0; i < 200 && pty === undefined; i++) await new Promise(r => setTimeout(r, 5));
    // A DISPLAY on the login's pty is what makes gcloud open a browser at all instead of printing a code to paste.
    expect(link.ptys[0]!.created["env"]).toEqual({ DISPLAY: CALLBACK_DISPLAY });
    // The shim: the machine asks the host to open the same page, this time naming the port its redirect returns to.
    expect(hooks.autoOpen(BUILDER.id, GCLOUD_PAGE, 8085)).toBe(false);
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "signed-in" });
    const announced = st.json.filter(j => j["event"] === "sign-in");
    // The whole sequence, not its end: the row stands with no road before any page, and never asks for a code while
    // its callback forward is on its way.
    expect(announced.map(j => j["finish"])).toEqual([undefined, "callback"]);
    expect(announced.at(-1)).toMatchObject({ browserUrl: GCLOUD_PAGE });
    expect(announced.every(j => j["code"] === undefined)).toBe(true);
  });

  it("a callback login whose page came back with no forwarded port takes the code the person pastes: it reaches the tool's own pty as a typed line and is printed nowhere", async () => {
    const link = fakePtyLink();
    let pty: FakePty | undefined;
    link.script = (p, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(p, `No credentialed accounts.\r\nWSP_STATUS 0\r\n`);
        link.exit(p, 0);
        return;
      }
      if (pty !== undefined) {
        // The code the person pasted: gcloud takes it and the login ends.
        link.exit(p, 0);
        return;
      }
      pty = p;
      link.data(p, `Go to the following link in your browser:\r\n\r\n    ${GCLOUD_PASTE}\r\n\r\nEnter authorization code: `);
    };
    const codes = new SignInCodes();
    const st = stage(link, { logins: [GCLOUD], codes, deadlineMs: 2_000, pollMs: 20 });
    for (let i = 0; i < 200 && pty === undefined; i++) await new Promise(r => setTimeout(r, 5));
    const asked = st.json.filter(j => j["event"] === "sign-in");
    expect(asked.map(j => j["finish"])).toEqual([undefined, "code"]);
    expect(asked.at(-1)).toMatchObject({ browserUrl: GCLOUD_PASTE });
    await codes.submit("gcloud", PASTED);
    expect(link.typed(pty!, `${PASTED}\r`)).toBe(true);
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "signed-in", exit: 0, note: "gcloud auth login exited 0" });
    // The code goes to the machine and nowhere else: not the lines, not the objects, not the row.
    expect(st.text()).not.toContain(PASTED);
    expect(JSON.stringify(st.json)).not.toContain(PASTED);
    // The login is gone, so its writer is closed with it.
    await expect(codes.submit("gcloud", PASTED)).rejects.toThrow(/waiting for a code/);
  });

  it("a login on neither road opens no writer at all: a code submitted for it is refused and its row says so", async () => {
    const codes = new SignInCodes();
    const st = stage(ghLink({ after: 99, hold: true }), { codes, deadlineMs: 200, pollMs: 20 });
    await expect(codes.submit("gh", CODE)).rejects.toThrow(/no sign-in for gh is waiting for a code/);
    await st.run;
    expect(st.json.filter(j => j["event"] === "sign-in").at(-1)).toMatchObject({ finish: "none" });
  });

  it("with no --json nothing is printed as an object and the lines still say the page and the outcome", async () => {
    const st = stage(ghLink({ after: 0, hold: true }), { json: undefined });
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "signed-in" });
    expect(st.text()).toContain(`GitHub CLI login: open ${DEVICE} on this computer`);
    expect(st.text()).not.toContain("{");
  });
});
