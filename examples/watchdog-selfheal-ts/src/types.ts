export type WatchdogResult =
  | { passed: true; summary: string }
  | {
      passed: false
      summary: string
      url: string
      screenshotPath: string
      html: string
      consoleErrors: string[]
      sessionId: string
    }

export type BugReport = Extract<WatchdogResult, { passed: false }>
