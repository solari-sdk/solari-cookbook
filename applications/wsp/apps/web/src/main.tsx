// SPDX-License-Identifier: AGPL-3.0-only
import { createRoot } from "react-dom/client";
import { BootGate } from "./BootGate.js";
import { bootPayload } from "./boot.js";
import { GlassGround } from "./components/GlassGround.js";
import "./index.css";
import "./themes/index.js";

const cfg = bootPayload();
if (cfg === undefined) throw new Error("the page has no window.__WSP__ boot object");
createRoot(document.getElementById("root")!).render(
  <>
    <GlassGround />
    <BootGate boot={cfg} at={window.location} agent={navigator.userAgent} storage={window.localStorage} />
  </>,
);
