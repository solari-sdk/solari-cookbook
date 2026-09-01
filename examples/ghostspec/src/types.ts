/** The contract every stage passes along. Keep it boring and serialisable. */

/** One thing the explorer actually did, in Playwright's own vocabulary. */
export type Step = {
  /** Playwright verb. `expect` is an assertion, not an interaction. */
  action: "goto" | "click" | "fill" | "press" | "select" | "expect"
  /**
   * A Playwright locator *expression*, verbatim — `getByRole('button', { name: 'Sign in' })`.
   * Not a CSS string: we hand this straight to codegen, and role/name locators are the
   * ones that survive a redesign. Absent for `goto`.
   */
  locator?: string
  /** Text to fill, key to press, option to select, or the expected text for `expect`. */
  value?: string
  /** Why the model did this. Becomes a comment in the generated spec. */
  note: string
}

/** What one exploration run produced. */
export type Trace = {
  url: string
  /** The plain-English flow the user asked for. */
  goal: string
  steps: Step[]
  /** Set when the explorer gave up: the reason, in the model's words. */
  failed?: string
  /** Solari session id, for the replay link. */
  sessionId?: string
  replayUrl?: string
  screenshots: string[]
}

/** What running the generated spec produced. */
export type RunResult = {
  spec: string
  passed: number
  failed: number
  /** stdout+stderr of the run, trimmed. */
  output: string
}
