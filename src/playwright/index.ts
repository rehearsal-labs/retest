// What a Playwright test file gets when `retest run --playwright` resolves `@playwright/test` here: Playwright's
// names over Retest's API and Retest's judgement. A member Retest does not have yet fails where it is used, by name.
export type { Finders, Keyboard, Locator, Page, RoleOptionsFor, SelectOptionChoice, Unanswered } from './page.ts'
export { defineConfig, devices } from './config.ts'
export { expect } from './expect.ts'
export type { PlaywrightExpect, PlaywrightMatcherOptions, PlaywrightMatchers } from './expect.ts'
export { test } from './test.ts'
export type { PlaywrightFixtures, PlaywrightTest } from './test.ts'
