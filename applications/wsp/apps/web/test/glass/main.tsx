// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: a column of text with two frosted panes over it, the composer's shell and a
// surface-glass box, on a page marked the way the macOS preload marks it (?theme=light for the light theme).
// The test photographs it on a transparent ground, which is what the Mac window gives the page.
import { DESKTOP_MAC_CLASS } from "@wsp/protocol";
import { createRoot } from "react-dom/client";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import { GlassGround } from "../../src/components/GlassGround";
import "../../src/index.css";
import "../../src/themes/index";

const theme = new URLSearchParams(window.location.search).get("theme") === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.classList.add(DESKTOP_MAC_CLASS);

const TEXT = Array.from({ length: 700 }, (_, i) => `line${i % 9} word`).join(" ");

createRoot(document.getElementById("root")!).render(
  <>
    <GlassGround />
    <p className="fixed inset-0 m-0 p-3 text-sm text-foreground">{TEXT}</p>
    <div data-glass="composer" className="fixed top-[100px] left-[100px] w-[320px]">
      <ComposerSurface.Shell>
        <div className="h-[160px]" />
      </ComposerSurface.Shell>
    </div>
    <div data-glass="surface" className="surface-glass fixed top-[100px] left-[500px] h-[160px] w-[320px] rounded-xl" />
  </>,
);
