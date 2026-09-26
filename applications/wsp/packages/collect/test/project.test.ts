// SPDX-License-Identifier: AGPL-3.0-only
// What a project folder's own files say it needs: the readers one by one, the
// names they land on in the catalog, the candidates the catalog has no row
// for, and the line each row shows.
import { describe, expect, it } from "vitest";
import { PROJECT_READERS, scanProject } from "../src/project/index.js";
import { fakeHost } from "./fake-host.js";

const PROJ = "/Users/dev/proj";
const project = (files: Record<string, string>) => fakeHost({ files: Object.fromEntries(Object.entries(files).map(([k, v]) => [`${PROJ}/${k}`, v])) });
const why = (scan: Awaited<ReturnType<typeof scanProject>>) => Object.fromEntries(scan.rows.map(n => [n.id, n.why]));

describe("scanProject", () => {
  it("a repo with a compose file, a pnpm lock and a go.mod ticks docker, pnpm and go, each saying which file asked", async () => {
    const scan = await scanProject(project({ "compose.yaml": "services:\n  db:\n    image: postgres\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "go.mod": "module example.com/x\n\ngo 1.24\n" }), PROJ);
    expect(scan.rows).toEqual([
      { id: "pnpm", name: "pnpm", why: "pnpm-lock.yaml needs pnpm" },
      { id: "go", name: "Go", why: "go.mod needs Go" },
      { id: "docker", name: "Docker engine and compose", why: "compose.yaml needs Docker" },
    ]);
    expect(scan.candidates).toEqual([]);
    expect(scan.dir).toBe(PROJ);
  });

  it("package.json: the manager it pins, every runtime its engines field accepts, and the catalog's own tools its scripts run", async () => {
    const scan = await scanProject(project({ "package.json": JSON.stringify({ packageManager: "pnpm@10.1.0", engines: { node: ">=22" }, scripts: { build: "tsup src/index.ts", deploy: "pnpm build && wrangler deploy", ci: "docker compose up -d" } }) }), PROJ);
    expect(why(scan)).toEqual({ pnpm: "packageManager pnpm@10.1.0", node: "engines.node >=22", wrangler: "package.json scripts run wrangler", docker: "package.json scripts run docker" });
    // A script's first word names a devDependency as often as a machine tool: tsup is not a candidate for a row of its own.
    expect(scan.candidates).toEqual([]);
  });

  it("the toolchain pins name a tool and its version, in asdf's syntax and in mise's, and the pin file itself asks for mise", async () => {
    const asdf = await scanProject(project({ ".tool-versions": "# pinned\nnodejs 22.1.0\ngolang 1.24.0\n\nruby 3.3.5\n" }), PROJ);
    expect(why(asdf)).toEqual({ node: ".tool-versions names nodejs 22.1.0", go: ".tool-versions names golang 1.24.0", ruby: ".tool-versions names ruby 3.3.5", mise: ".tool-versions needs mise" });
    expect(asdf.candidates).toEqual([]);
    const mise = await scanProject(project({ "mise.toml": '[tools]\ngo = "1.24"\npython = ["3.12"]\n\n[env]\nGOFLAGS = "-mod=mod"\n' }), PROJ);
    expect(why(mise)).toEqual({ go: "mise.toml names go 1.24", python: "mise.toml names python 3.12", mise: "mise.toml needs mise" });
  });

  it("package.json dependencies: a package the project installs itself by npm is not a need of the machine; one whose row installs more than the package is", async () => {
    const pkg = JSON.stringify({ dependencies: { react: "^19.0.0", "@railway/cli": "^4.0.0" }, devDependencies: { "@playwright/test": "^1.62.1", eslint: "^9.0.0", typescript: "^5.0.0", vercel: "^41.0.0" } });
    const scan = await scanProject(project({ "package.json": pkg }), PROJ);
    // eslint, typescript, vercel and the Railway CLI are npm globals in the catalog: the project's own install covers them.
    // Playwright's row installs its Chromium and the browser's Debian packages, which no dependency brings.
    expect(why(scan)).toEqual({ playwright: "package.json depends on @playwright/test ^1.62.1" });
    // A dependency the catalog has no row for is the project's to install, never a custom row candidate.
    expect(scan.candidates).toEqual([]);
    const plain = await scanProject(project({ "package.json": JSON.stringify({ devDependencies: { playwright: "1.62.1" } }) }), PROJ);
    expect(why(plain)).toEqual({ playwright: "package.json depends on playwright 1.62.1" });
    // A client library shares its name with the server's tools: node-redis is not a need for redis-cli, the sqlite
    // binding not one for the sqlite3 shell, and an npm package called chromium is not a browser.
    const clients = await scanProject(project({ "package.json": JSON.stringify({ dependencies: { redis: "^4.7.0", sqlite: "^5.1.1", pg: "^8.0.0", chromium: "^3.0.0", bun: "^1.0.0" } }) }), PROJ);
    expect(clients).toEqual({ dir: PROJ, rows: [], candidates: [] });
  });

  it("a workspace package's own package.json counts, under apps or packages, and says which one asked", async () => {
    const scan = await scanProject(project({ "package.json": JSON.stringify({ private: true }), "apps/web/package.json": JSON.stringify({ devDependencies: { playwright: "1.62.1" } }), "packages/cli/package.json": JSON.stringify({ scripts: { release: "gh release create" } }), "apps/README.md": "# apps" }), PROJ);
    expect(why(scan)).toEqual({ playwright: "apps/web/package.json depends on playwright 1.62.1", gh: "packages/cli/package.json scripts run gh" });
  });

  it("a workflow's setup actions and the tools its run steps call, inline and in a block", async () => {
    const yml = ["jobs:", "  build:", "    steps:", "      - uses: actions/setup-go@v5", "      - uses: pnpm/action-setup@v4", "      - run: go build ./...", "      - run: |", "          docker compose up -d", "          npm ci", "      - name: after", "        run: echo done"].join("\n");
    const scan = await scanProject(project({ ".github/workflows/ci.yml": yml }), PROJ);
    expect(why(scan)).toEqual({
      go: ".github/workflows/ci.yml sets up go",
      pnpm: ".github/workflows/ci.yml sets up pnpm",
      docker: ".github/workflows/ci.yml runs docker",
      node: ".github/workflows/ci.yml runs npm",
    });
  });

  it("an action named after its owner is that owner's tool, not a candidate for the action's own name", async () => {
    const yml = ["jobs:", "  build:", "    steps:", "      - uses: docker/setup-buildx-action@v3", "      - uses: docker/setup-qemu-action@v3", "      - uses: actions/setup-dotnet@v4"].join("\n");
    const scan = await scanProject(project({ ".github/workflows/ci.yml": yml }), PROJ);
    expect(why(scan)).toEqual({ docker: ".github/workflows/ci.yml sets up docker" });
    // A setup action nobody's catalog carries is still a real ask, under the toolchain it names.
    expect(scan.candidates).toEqual([{ id: "dotnet", name: "dotnet", why: ".github/workflows/ci.yml sets up dotnet" }]);
  });

  it("an engines key the catalog has no row for is not a custom row candidate: engines names a runtime, not something to install", async () => {
    const scan = await scanProject(project({ "package.json": JSON.stringify({ engines: { node: ">=22", vscode: "^1.80.0" } }) }), PROJ);
    expect(why(scan)).toEqual({ node: "engines.node >=22" });
    expect(scan.candidates).toEqual([]);
  });

  it("corepack's integrity suffix stays out of the line the row shows", async () => {
    const spec = `pnpm@10.15.0+sha512.${"1234567890".repeat(8)}abcdefgh`;
    const scan = await scanProject(project({ "package.json": JSON.stringify({ packageManager: spec }) }), PROJ);
    expect(why(scan)).toEqual({ pnpm: "packageManager pnpm@10.15.0" });
  });

  it("a marker is read for its presence alone: a lockfile of megabytes, or bytes that are not text, is never opened", async () => {
    const host = project({ "package-lock.json": "{}", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    const scan = await scanProject(host, PROJ);
    expect(scan.rows.map(n => n.id)).toEqual(["pnpm", "node"]);
    expect(host.calls.filter(c => c.includes("lock"))).toEqual([]);
  });

  it("a Gemfile and a composer.json tick Ruby and PHP, and the first file to name a tool writes its line", async () => {
    const scan = await scanProject(project({ Gemfile: 'source "https://rubygems.org"\n', "composer.json": "{}", "package.json": JSON.stringify({ packageManager: "pnpm@10.1.0" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" }), PROJ);
    expect(why(scan)).toEqual({ pnpm: "packageManager pnpm@10.1.0", ruby: "Gemfile needs Ruby", php: "composer.json needs PHP" });
    expect(scan.rows.map(n => n.name)).toEqual(["pnpm", "Ruby 3.1 with bundler", "PHP 8.2 with Composer"]);
    expect(scan.candidates).toEqual([]);
  });

  it("a folder with nothing to read, and one that is not there at all, ask for nothing", async () => {
    expect(await scanProject(project({ "README.md": "# x" }), PROJ)).toEqual({ dir: PROJ, rows: [], candidates: [] });
    expect(await scanProject(project({}), `${PROJ}/`)).toEqual({ dir: PROJ, rows: [], candidates: [] });
  });

  it("every reader is registered once and names the files it reads", () => {
    expect(PROJECT_READERS.map(r => r.id)).toEqual(["package-json", "toolchain-pins", "marker", "workflows"]);
    expect(new Set(PROJECT_READERS.map(r => r.id)).size).toBe(PROJECT_READERS.length);
    for (const reader of PROJECT_READERS) expect(reader.files.length).toBeGreaterThan(0);
  });
});
