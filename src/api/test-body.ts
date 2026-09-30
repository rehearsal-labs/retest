import type { Page } from './page.ts'

/** What a test receives. Each test gets a fresh page in a new browser context. */
export type TestContext = { readonly page: Page }

/** A test's callback. Await every page action and assertion inside it. */
export type TestBody = (context: TestContext) => void | Promise<void>
