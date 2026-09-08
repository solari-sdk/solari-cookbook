import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe as group, expect, it } from "vitest"
import { summarise } from "../src/aggregate.js"
import { createAgent, type Agent, type PageLike } from "../src/agent.js"
import type { FixtureHost } from "../src/fixture-host.js"
import { ResourceStack } from "../src/lifecycle.js"
import { planTrials, runAll } from "../src/run.js"
import { parseSuite, type SuiteSpec } from "../src/suite.js"
import type { ServerState } from "../src/verify.js"

/**
 * The whole pipeline, end to end, against the real benchmark site over real
 * HTTP — with the Solari calls, and only those, replaced.
 *
 * Perturbation resolution, the site's per-run rendering, the agent loop, the
 * server-state verdict, failure classification and aggregation all run for
 * real here. What is faked is the browser: this drives the shop with `fetch`
 * and form posts rather than Chromium, which is enough to prove the harness is
 * wired correctly and cheap enough to run on every commit.
 *
 * It does not execute JavaScript, so the two perturbations that depend on an
 * in-page timer (`unexpected_modal`, `delayed_element`) are not exercised here.
 */
const SHOP = fileURLToPath(new URL("../fixture/shop.py", import.meta.url))
const PORT = 8749
const BASE = `http://127.0.0.1:${PORT}`

let server: ChildProcess | undefined

beforeAll(async () => {
  const directory = mkdtempSync(join(tmpdir(), "shop-"))
  const script = join(directory, "shop.py")
  writeFileSync(
    script,
    readFileSync(SHOP, "utf8").replace("PORTNUM", String(PORT)).replace("BINDHOST", "127.0.0.1"),
  )

  server = spawn("python3", [script], { stdio: "ignore" })

  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      if ((await fetch(`${BASE}/__suite/health`)).ok) return
    } catch {
      // not listening yet
    }
  }
  throw new Error("the fixture never came up")
}, 20_000)

afterAll(() => void server?.kill())

/** A FixtureHost backed by the local server instead of a Solari sandbox. */
const fixture: FixtureHost = {
  urlFor: (path, runId) => `${BASE}${path}?run=${encodeURIComponent(runId)}`,
  async register(runId, variant, seed, config) {
    await fetch(`${BASE}/__suite/session`, {
      method: "POST",
      body: JSON.stringify({ runId, variant, seed, config }),
    })
  },
  async readState(runId) {
    const response = await fetch(fixture.urlFor("/__suite/state", runId))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as ServerState
  },
}

/**
 * A page that submits forms with `fetch`.
 *
 * `actionable` answers the way a browser would: a control under the consent
 * banner is present in the markup and still not clickable.
 */
function httpPage(): PageLike {
  let html = ""
  let url = ""
  const typed = new Map<string, string>()

  const forms = (): Array<{ action: string; body: string }> =>
    [...html.matchAll(/<form[^>]*action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => ({
      action: (m[1] as string).replace(/&amp;/g, "&"),
      body: m[2] as string,
    }))

  const has = (selector: string): boolean => html.includes(`id="${selector.slice(1)}"`)

  const go = async (target: string, init?: RequestInit): Promise<void> => {
    const response = await fetch(target, init)
    html = await response.text()
    url = response.url || target
  }

  return {
    goto: async (target) => {
      await go(target)
    },
    fill: async (selector, value) => {
      typed.set(selector, value)
    },
    click: async (selector) => {
      const form = forms().find((f) => f.body.includes(`id="${selector.slice(1)}"`))
      if (!form) throw new Error(`no form contains ${selector}`)

      const fields = new URLSearchParams()
      for (const input of form.body.matchAll(/<input[^>]*id="([^"]+)"[^>]*name="([^"]+)"/g)) {
        fields.set(input[2] as string, typed.get(`#${input[1] as string}`) ?? "")
      }
      await go(new URL(form.action, url).toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: fields.toString(),
      })
    },
    actionable: async (selector) => {
      if (!has(selector)) return false
      // The expired page replaces everything; only "resume" is reachable.
      if (has("#resume") && selector !== "#resume") return false
      // The banner covers the controls beneath it.
      if (has("#banner") && selector !== "#accept-cookies") return false
      return true
    },
    waitMs: async () => {},
  }
}

function suiteOf(variants: string[]): SuiteSpec {
  const spec = parseSuite(readFileSync(fileURLToPath(new URL("../suite.json", import.meta.url)), "utf8"))
  return { ...spec, variants, repetitions: 1, concurrency: 2 }
}

async function run(preset: "naive" | "resilient", variants: string[]) {
  const suite = suiteOf(variants)
  const trials = planTrials(suite, `test-${preset}-${variants.join("-")}`)
  const outcomes = await runAll(
    {
      fixture,
      suite,
      agent: createAgent(preset),
      log: () => {},
      stack: new ResourceStack(),
      openPage: async () => ({ page: httpPage(), capture: async () => null }),
    },
    trials,
    suite.concurrency,
  )
  return summarise(preset, outcomes.map((o) => o.result))
}

group("the pipeline, end to end", () => {
  it("stops waiting on an agent that never returns, and still reads the server", async () => {
    // The budget exists so a wedged agent cannot hold a paid browser session
    // open indefinitely. The trial is still judged afterwards: the session is
    // released either way, and the shop knows what did or did not happen.
    const suite = { ...suiteOf(["baseline"]), task: { ...suiteOf(["baseline"]).task, timeoutMs: 150 } }
    let released = false
    const stack = new ResourceStack()

    const outcomes = await runAll(
      {
        fixture,
        suite,
        agent: {
          name: "wedged",
          run: () => new Promise(() => {}),
        },
        log: () => {},
        stack,
        openPage: async (trialStack) => {
          trialStack.add("browser session", null, async () => void (released = true))
          return { page: httpPage(), capture: async () => null }
        },
      },
      planTrials(suite, "test-deadline"),
      1,
    )

    expect(outcomes[0]?.result.agent?.finishReason).toBe("timeout")
    // Released despite the agent never finishing, and still judged from state.
    expect(released).toBe(true)
    expect(outcomes[0]?.result.verdict.surface).toBe("server_state")
    expect(outcomes[0]?.result.outcome).toBe("fail")
  })

  it("passes the unperturbed control", async () => {
    const result = await run("naive", ["baseline"])
    expect(result.reliability.point).toBe(1)
    expect(result.trials[0]?.verdict.surface).toBe("server_state")
  })

  it("fails the naive agent on the banner, and says why from server evidence", async () => {
    const result = await run("naive", ["cookie_banner"])
    expect(result.reliability.point).toBe(0)
    expect(result.trials[0]?.failure).toMatchObject({ category: "unexpected_ui", blame: "agent" })
  })

  it("passes the resilient agent on the same banner", async () => {
    // Same task, same environment, one extra capability. This difference is
    // the measurement the whole application exists to produce.
    const result = await run("resilient", ["cookie_banner"])
    expect(result.reliability.point).toBe(1)
  })

  it("fails the naive agent when the session expires, and the resilient one resumes", async () => {
    expect((await run("naive", ["expired_session"])).reliability.point).toBe(0)
    expect((await run("resilient", ["expired_session"])).reliability.point).toBe(1)
  }, 20_000)

  it("still completes when the API is slow", async () => {
    const result = await run("resilient", ["slow_api"])
    expect(result.reliability.point).toBe(1)
  }, 30_000)

  it("separates the control from the perturbed arm across a grid", async () => {
    const result = await run("naive", ["baseline", "cookie_banner"])
    expect(result.baseline?.point).toBe(1)
    expect(result.perturbed?.point).toBe(0)
    expect(result.reliability.point).toBe(0.5)
  })

  it("fails an agent that does nothing and reports success", async () => {
    // The thesis, asserted end to end. This agent touches nothing and claims it
    // finished. A harness that believed self-reports would score it 100%.
    const suite = suiteOf(["baseline"])
    const liar: Agent = {
      name: "liar",
      run: async () => ({
        finishReason: "finished",
        steps: 7,
        message: "Reached the review page",
      }),
    }

    const outcomes = await runAll(
      {
        fixture,
        suite,
        agent: liar,
        log: () => {},
        stack: new ResourceStack(),
        openPage: async () => ({ page: httpPage(), capture: async () => null }),
      },
      planTrials(suite, "test-liar"),
      1,
    )
    const result = summarise("liar", outcomes.map((o) => o.result))
    const trial = result.trials[0]

    // The claim is recorded in full...
    expect(trial?.agent?.finishReason).toBe("finished")
    expect(trial?.agent?.message).toBe("Reached the review page")
    // ...and the server, which saw nothing happen, decides.
    expect(trial?.outcome).toBe("fail")
    expect(result.reliability.point).toBe(0)
    expect(trial?.failure).toMatchObject({ category: "no_progress", blame: "agent" })
  })

  it("records what the naive agent claimed, without letting it count", async () => {
    const result = await run("naive", ["cookie_banner"])
    const trial = result.trials[0]
    // It ran off the rails once the banner blocked it, and said so.
    expect(trial?.agent?.finishReason).toBe("error")
    // The verdict came from the server either way.
    expect(trial?.outcome).toBe("fail")
    expect(trial?.verdict.surface).toBe("server_state")
  })
})
