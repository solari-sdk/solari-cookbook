// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT } from "@wsp/catalog";
import { DEFAULT_HARNESS } from "../src/components/chat/ComposerOptionPickers.js";
import { HARNESS_CLIENTS, catalogFor, catalogFromHarness, composerPlaceholder, deriveSession, harnessClient, offersSlashCommands, slashHoldLine } from "../src/adapt/index.js";
import { CHAT_HARNESS, CHAT_STREAM } from "./fixtures/chat-stream.js";

describe("the client's harness registry", () => {
  it("has one module per harness, each seeding the slash menu with names without their slash", () => {
    expect(HARNESS_CLIENTS.map(c => c.harness)).toEqual(["claude", "codex", "gemini", "opencode", "pi"]);
    for (const c of HARNESS_CLIENTS) {
      expect(harnessClient(c.harness)).toBe(c);
      for (const s of c.slashCommands) expect(s.name).not.toMatch(/^\//);
    }
    expect(harnessClient("hermes")).toBeUndefined();
    // The composer's first pick is the catalog's default agent, the same fact the runtime starts an unnamed thread on.
    expect(DEFAULT_HARNESS).toBe(DEFAULT_AGENT.id);
  });

  it("resolves a catalog by the harness id sessions.start uses, from the registered module alone", () => {
    for (const c of HARNESS_CLIENTS) expect(catalogFor(c.harness)).toEqual({ harness: c.harness, slashCommands: c.slashCommands });
    expect(catalogFor("hermes")).toBeNull();
  });
});

describe("catalogFromHarness", () => {
  it("builds the slash menu from what the session announced, under the thread's harness", () => {
    const model = deriveSession(CHAT_STREAM);
    expect(model.harness).toEqual(CHAT_HARNESS);
    const catalog = catalogFromHarness({ id: "claude", harness: model.harness });
    expect(catalog.harness).toBe("claude");
    expect(catalog.slashCommands.map(c => c.name)).toEqual(["compact", "context", "cost", "init", "review"]);
  });

  it("keeps the commands that work only in the CLI's own terminal out of the menu, and offers every other one the CLI announced", () => {
    const screen = [{ name: "login", control: "sign-in" as const }, { name: "model", control: "model" as const }];
    const announced = { slashCommands: ["compact", "login", "review", "model", "my-skill"] };
    expect(catalogFromHarness({ id: "claude", harness: announced, screen }).slashCommands.map(c => c.name)).toEqual(["compact", "review", "my-skill"]);
    // Without a table every announced command is offered: a catalog from before the field names no screen command.
    expect(catalogFromHarness({ id: "claude", harness: announced, screen: [] }).slashCommands.map(c => c.name)).toEqual(announced.slashCommands);
    expect(catalogFromHarness({ id: "claude", harness: announced }).slashCommands.map(c => c.name)).toEqual(announced.slashCommands);
  });

  it("falls back to the harness's registered seed when the CLI named no commands, and to nothing for a harness with no module", () => {
    const seed = harnessClient("claude")!.slashCommands;
    expect(catalogFromHarness({ id: "claude", harness: null })).toEqual({ harness: "claude", slashCommands: seed });
    expect(catalogFromHarness({ id: "claude", harness: { permissionMode: "plan" } }).slashCommands).toBe(seed);
    expect(catalogFromHarness({ id: "codex", harness: null })).toEqual({ harness: "codex", slashCommands: [] });
    expect(catalogFromHarness({ id: "codex", harness: { slashCommands: ["diff"] } }).slashCommands.map(c => c.name)).toEqual(["diff"]);
  });
});

describe("the composer's placeholder", () => {
  it("names the slash menu only once a session announced a command the menu can offer", () => {
    const announced = catalogFromHarness({ id: "claude", harness: CHAT_HARNESS });
    expect(offersSlashCommands(announced)).toBe(true);
    expect(composerPlaceholder(announced)).toBe("Ask anything, or / for commands");

    const fresh = catalogFromHarness({ id: "claude", harness: null });
    expect(offersSlashCommands(fresh)).toBe(false);
    expect(composerPlaceholder(fresh)).toBe("Ask anything");

    // A CLI that announced only the commands its own terminal runs leaves the menu with nothing, so the words go too.
    const screenOnly = catalogFromHarness({ id: "claude", harness: { slashCommands: ["login"] }, screen: [{ name: "login", control: "sign-in" }] });
    expect(offersSlashCommands(screenOnly)).toBe(false);
    expect(composerPlaceholder(screenOnly)).toBe("Ask anything");
  });
});

describe("the source an announced name carries", () => {
  it("is read by the harness's own module, since only it knows how its CLI spells one", () => {
    // The harness this module is registered for names a plugin's or a scoped skill's command <source>:<command>.
    const claude = catalogFromHarness({ id: "claude", harness: { slashCommands: ["compact", "code-review:code-review", "apps/web:deploy", "my-skill"] } });
    expect(claude.slashCommands).toEqual([
      { name: "compact" },
      { name: "code-review:code-review", source: "code-review" },
      { name: "apps/web:deploy", source: "apps/web" },
      { name: "my-skill" },
    ]);
    // A harness whose module registers no reading announces bare names, and its menu is one list.
    expect(harnessClient("codex")?.announced).toBeUndefined();
    expect(catalogFromHarness({ id: "codex", harness: { slashCommands: ["a:b"] } }).slashCommands).toEqual([{ name: "a:b" }]);
  });
});

describe("a draft that is a slash and nothing more", () => {
  const catalog = catalogFromHarness({ id: "claude", harness: { slashCommands: ["compact", "my-skill"] } });
  const screen = [{ name: "login", control: "sign-in" as const }];

  it("is held, and says why in the composer's own words", () => {
    expect(slashHoldLine({ prompt: "/", catalog })).toBe("a slash on its own is not a command");
    expect(slashHoldLine({ prompt: "  /  ", catalog })).toBe("a slash on its own is not a command");
    expect(slashHoldLine({ prompt: "/heapdump", catalog })).toBe("no command here is called /heapdump");
  });

  it("goes as it always did once it is a command that was announced, or words that may be meant", () => {
    expect(slashHoldLine({ prompt: "/compact", catalog })).toBeNull();
    expect(slashHoldLine({ prompt: "/my-skill", catalog })).toBeNull();
    expect(slashHoldLine({ prompt: "/heapdump of the daemon", catalog })).toBeNull();
    expect(slashHoldLine({ prompt: "read /etc/hosts", catalog })).toBeNull();
    expect(slashHoldLine({ prompt: "", catalog })).toBeNull();
  });

  it("leaves a command that runs only in the CLI's own terminal to the line that names wsp's road for it", () => {
    expect(slashHoldLine({ prompt: "/login", catalog, screen })).toBeNull();
    expect(slashHoldLine({ prompt: "/login", catalog })).toBe("no command here is called /login");
  });

  it("holds the lone slash even where nothing was announced, and holds no name there, since any name may be meant", () => {
    const fresh = catalogFromHarness({ id: "claude", harness: null });
    expect(slashHoldLine({ prompt: "/", catalog: fresh })).toBe("a slash on its own is not a command");
    expect(slashHoldLine({ prompt: "/compact", catalog: fresh })).toBeNull();
  });
});
