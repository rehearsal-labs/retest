// What a Playwright test file gets when `retest run --playwright` resolves `@playwright/test` here: Playwright's
// names over Retest's API and Retest's judgement. A member Retest does not have yet fails where it is used, by name.
export type { Locator, Page } from '../api/page.ts'
export { defineConfig, devices } from './config.ts'
export { expect } from './expect.ts'
export type { PlaywrightExpect, PlaywrightMatchers } from './expect.ts'
export { test } from './test.ts'
export type { PlaywrightFixtures, PlaywrightTest } from './test.ts'
