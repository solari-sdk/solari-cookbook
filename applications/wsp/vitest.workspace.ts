// Vitest 2.x workspace: each entry runs under its own config/environment.
// Node packages + wspx use the root node config; apps/web carries its own
// vite config (react plugin + jsdom) so React component tests get a DOM.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_ENV } from "./vitest.env.js";

// Paths are pinned to this file, not the cwd, so a run started inside one package sees the same tree as a root run.
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const pkg = (name: string) => here(`./packages/${name}/src/index.ts`);
/** A markdown import is its text, as tsup's text loader makes it in the host's build. */
const markdownText = () => ({
  name: "md-text",
  load: (id: string) => (id.endsWith(".md") ? `export default ${JSON.stringify(readFileSync(id, "utf8"))};` : undefined),
});

const alias = {
  "@wsp/engine": pkg("engine"),
  "@wsp/adapter-claude": pkg("adapter-claude"),
  "@wsp/adapter-codex": pkg("adapter-codex"),
  "@wsp/keys": pkg("keys"),
  "@wsp/own-file": pkg("own-file"),
  "@wsp/protocol": pkg("protocol"),
  "@wsp/runtime": pkg("runtime"),
  "@wsp/host": pkg("host"),
  "@wsp/collect": pkg("collect"),
  "@wsp/catalog": pkg("catalog"),
};

export default [
  {
    root: here("./"),
    plugins: [markdownText()],
    resolve: { alias },
    test: {
      name: "node",
      include: ["packages/*/test/**/*.test.ts", "infra/*/test/**/*.test.ts", "apps/wspx/**/*.test.ts", "apps/desktop/test/**/*.test.ts"],
      environment: "node",
      // Anything a test writes to the OS-local config dir (the install id) lands here, never in the developer's own.
      env: { XDG_CONFIG_HOME: join(tmpdir(), "wsp-test-config"), ...TEST_ENV },
    },
  },
  here("./apps/web/vite.config.ts"),
  here("./apps/www/vite.config.ts"),
];
