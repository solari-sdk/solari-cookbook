// SPDX-License-Identifier: AGPL-3.0-only
// The builder's daemon link as the sign-in tests script it: a login prints its
// page and exits, or waits for Ctrl-C when held; a status check answers with a
// quiet line. Shared by the terminal run's tests and the init job's.
import { fakePtyLink, type FakePtyLink } from "./fake-pty-link.js";

export const DEVICE_URL = "https://github.com/login/device";
/** The page a callback login prints when its own browser did not open: it returns somewhere that is not the
 * machine, so the flow hands a code back. Gemini CLI is the agent these tests sign in on a machine. */
export const GEMINI_URL = "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fauthcode.html";

/** Ptys on the fake builder: a login prints its page's URL and exits (or waits for Ctrl-C, or for a code typed into
 * it, when held). */
export function scriptedLink(state: { signedIn: boolean; hold: boolean; missing: boolean }): FakePtyLink {
  const link = fakePtyLink();
  link.script = (pty, line) => {
    // The secrets step's quiet runs: nothing set on the machine yet, no fish.
    if (line.includes("WSP_STATUS")) {
      link.data(pty, "\r\nWSP_STATUS 0\r\n");
      link.exit(pty, 0);
      return;
    }
    const typed = line.includes("; exec bash -c ");
    if (state.missing && typed) {
      link.data(pty, `bash: line 1: ${line.split("exec bash -c ")[1]!.split(" ")[0]}: command not found\r\n`);
      link.exit(pty, 127);
      return;
    }
    // A held login that is typed into: the code from its page, which the tool takes before it ends. A bare Enter is
    // the relay answering a question the row declares, and no tool ends on that.
    if (state.hold && line !== "" && !typed) {
      link.exit(pty, 0);
      return;
    }
    if (line.includes("exec bash -c gemini")) link.data(pty, `Opening browser to sign in...\r\nIf the browser didn't open, visit: \x1b]8;;${GEMINI_URL}\x1b\\${GEMINI_URL}\x1b]8;;\x1b\\\r\nPaste code here if prompted > `);
    else link.data(pty, `Press Enter to open ${DEVICE_URL} in your browser...\r\n`);
    if (!state.hold) link.exit(pty, state.signedIn ? 0 : 1);
  };
  const op = link.op.bind(link);
  link.op = async (name, extra = {}) => {
    const r = await op(name, extra);
    if (name === "pty.write" && extra["data"] === "\x03") link.exit(link.ptys.find(x => x.id === extra["ptyId"])!, 130);
    return r;
  };
  return link;
}
