import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  // One Solari session is one browser. A second worker would fight the first
  // over the same remote Chrome, so keep the suite serial per session.
  workers: 1,
  fullyParallel: false,
  globalSetup: './solari.global.ts',
  reporter: 'line',
  timeout: 60_000,
  use: {
    // Deliberately no `connectOptions` — see solari.ts. The connection is made
    // in a fixture, over CDP, which is why this config survives a Playwright
    // upgrade instead of 428-ing on anything that isn't 1.59.x.
    actionTimeout: 15_000,
  },
})
