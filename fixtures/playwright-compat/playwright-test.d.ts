// The repository typechecks this corpus without installing Playwright, so `@playwright/test` is declared here as the
// part of Playwright's own API the corpus uses, with Playwright's signatures as its documentation at playwright.dev
// gives them, written for this file. They are Playwright's, not Retest's compatibility types: a spec may use any form
// Playwright takes, such as a bare string for selectOption or a table row found by name, whether or not Retest runs
// it, so the corpus is never fitted to what Retest supports. The comparison runs the same files under the pinned
// Playwright itself, which is what shows each one is a Playwright test.
declare module '@playwright/test' {
  type TextMatch = string | RegExp
  type Timeout = { readonly timeout?: number }
  type ActionOptions = Timeout & { readonly force?: boolean; readonly noWaitAfter?: boolean; readonly trial?: boolean }
  type SelectChoice = string | { readonly value?: string; readonly label?: string; readonly index?: number }

  export type RoleOptions = {
    readonly name?: TextMatch
    readonly exact?: boolean
    readonly checked?: boolean
    readonly disabled?: boolean
    readonly expanded?: boolean
    readonly includeHidden?: boolean
    readonly level?: number
    readonly pressed?: boolean
    readonly selected?: boolean
  }

  export interface Finders {
    getByTestId(testId: TextMatch): Locator
    getByRole(role: string, options?: RoleOptions): Locator
    getByLabel(text: TextMatch, options?: { readonly exact?: boolean }): Locator
    getByText(text: TextMatch, options?: { readonly exact?: boolean }): Locator
    getByPlaceholder(text: TextMatch, options?: { readonly exact?: boolean }): Locator
    locator(selector: string, options?: { readonly hasText?: TextMatch }): Locator
  }

  export interface Locator extends Finders {
    first(): Locator
    last(): Locator
    nth(index: number): Locator
    fill(value: string, options?: ActionOptions): Promise<void>
    click(options?: ActionOptions & { readonly button?: 'left' | 'right' | 'middle'; readonly clickCount?: number }): Promise<void>
    hover(options?: ActionOptions): Promise<void>
    press(key: string, options?: Timeout & { readonly delay?: number; readonly noWaitAfter?: boolean }): Promise<void>
    check(options?: ActionOptions): Promise<void>
    uncheck(options?: ActionOptions): Promise<void>
    selectOption(values: SelectChoice | readonly SelectChoice[] | null, options?: ActionOptions): Promise<string[]>
  }

  export interface Keyboard {
    press(key: string, options?: { readonly delay?: number }): Promise<void>
  }

  /** What a navigation answers: the main document's response, or null when there was none. */
  export interface Response {
    ok(): boolean
    status(): number
    url(): string
  }

  type NavigationOptions = Timeout & { readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }

  export interface Page extends Finders {
    goto(url: string, options?: NavigationOptions & { readonly referer?: string }): Promise<Response | null>
    reload(options?: NavigationOptions): Promise<Response | null>
    goBack(options?: NavigationOptions): Promise<Response | null>
    goForward(options?: NavigationOptions): Promise<Response | null>
    title(): Promise<string>
    url(): string
    readonly keyboard: Keyboard
  }

  type RetryOptions = Timeout

  export interface LocatorAssertions {
    readonly not: LocatorAssertions
    toBeChecked(options?: RetryOptions & { readonly checked?: boolean }): Promise<void>
    toBeDisabled(options?: RetryOptions): Promise<void>
    toBeEnabled(options?: RetryOptions & { readonly enabled?: boolean }): Promise<void>
    toBeHidden(options?: RetryOptions): Promise<void>
    toBeVisible(options?: RetryOptions & { readonly visible?: boolean }): Promise<void>
    toContainText(expected: TextMatch | readonly TextMatch[], options?: RetryOptions & { readonly ignoreCase?: boolean; readonly useInnerText?: boolean }): Promise<void>
    toHaveCount(count: number, options?: RetryOptions): Promise<void>
    toHaveText(expected: TextMatch | readonly TextMatch[], options?: RetryOptions & { readonly ignoreCase?: boolean; readonly useInnerText?: boolean }): Promise<void>
    toHaveValue(value: TextMatch, options?: RetryOptions): Promise<void>
  }

  export interface PageAssertions {
    readonly not: PageAssertions
    toHaveTitle(title: TextMatch, options?: RetryOptions): Promise<void>
    toHaveURL(url: TextMatch, options?: RetryOptions & { readonly ignoreCase?: boolean }): Promise<void>
  }

  export interface ValueAssertions<Settled> {
    readonly not: ValueAssertions<Settled>
    toBe(expected: unknown): Settled
    toEqual(expected: unknown): Settled
    toContain(expected: unknown): Settled
    toMatch(expected: TextMatch): Settled
  }

  export interface Expect {
    (actual: Locator, message?: string): LocatorAssertions
    (actual: Page, message?: string): PageAssertions
    <Value>(actual: Value, message?: string): ValueAssertions<void>
    soft: Expect
    poll<Value>(read: () => Value | Promise<Value>, options?: { readonly message?: string; readonly timeout?: number; readonly intervals?: readonly number[] }): ValueAssertions<Promise<void>>
  }

  export type TestBody = (fixtures: { readonly page: Page }) => Promise<void> | void

  export interface TestType {
    (title: string, body: TestBody): void
    (title: string, details: { readonly tag?: string | readonly string[] }, body: TestBody): void
    describe(title: string, body: () => void): void
    beforeEach(body: TestBody): void
    afterEach(body: TestBody): void
    step<Value>(title: string, body: () => Value | Promise<Value>): Promise<Value>
    use(options: { readonly baseURL?: string; readonly storageState?: string }): void
  }

  export const test: TestType
  export const expect: Expect
}
