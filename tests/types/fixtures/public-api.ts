import { expect, test, type Locator, type Page, type TestContext } from '@rehearsal-labs/retest'

// Written the way the brief shows a test: every line here type-checks.
test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
  await expect(page.getByTestId('saved-task')).toBeVisible()
})

test('takes a timeout', { timeout: 5000 }, async ({ page }) => {
  const count: number = await test.step('Count tasks', async () => 2)
  const label: string = await test.step('Name it', () => 'two')
  expect(count).toBe(2)
  expect(label).toBe('two')
  await expect(page.getByTestId('task-count')).toHaveText(String(count))
})

// Optional options take undefined, so a project may pass what it has with exactOptionalPropertyTypes on.
declare const maybeTimeout: number | undefined
test('takes an unset timeout', { timeout: maybeTimeout, tags: undefined }, () => {
  expect(maybeTimeout).toBe(undefined)
})

test('may be synchronous', () => {
  expect(1 + 1).toBe(2)
})

declare const loose: any
declare const unknownValue: unknown
declare const maybeLocator: Locator | undefined
export async function helper(page: Page, context: TestContext): Promise<void> {
  expect<number>(loose).toBe(1)
  expect(unknownValue).toBe('anything')
  expect(maybeLocator).toBe(undefined)
  await context.page.getByTestId('save-task').click()
  await page.goto('https://example.com/')
}

test('unknown option', { retries: 2 }, async () => {}) // type-error TS2353 'retries' does not exist in type
test('timeout as text', { timeout: '5s' }, async () => {}) // type-error TS2322 Type 'string' is not assignable to type 'number'
test('extra fixture', async ({ page, browser }) => {}) // type-error TS2339 Property 'browser' does not exist on type 'TestContext'
test(42, async () => {}) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'

test('type mismatch', async ({ page }) => {
  expect(3 as number).toBe('3') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'number'
  expect('Saved').toBe(null) // type-error TS2345 Argument of type 'null' is not assignable to parameter of type 'string'
  expect(page.getByTestId('saved-task')).toBe('Saved') // type-error TS2349 Type 'RetestTypeError<"toBe is for values. Use toHaveText or toBeVisible on a locator.">' has no call signatures
  await expect(3).toBeVisible() // type-error TS2349 Type 'RetestTypeError<"toBeVisible is for locators. Use toBe on a value.">' has no call signatures
  await expect('Saved').toHaveText('Saved') // type-error TS2349 Type 'RetestTypeError<"toHaveText is for locators. Use toBe on a value.">' has no call signatures
  expect(loose).toBe(1) // type-error TS2339 Property 'toBe' does not exist on type 'RetestTypeError<"expect() received a value typed any. Write expect<T>(value) with its type.">'
  expect(page.goto('/')).toBe(undefined) // type-error TS2339 Property 'toBe' does not exist on type 'RetestTypeError<"Await the promise before expect().">'
  await expect(page.getByTestId('saved-task')).toHaveText(3) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string | readonly string[]'
})

test('wrong arguments', async ({ page }) => {
  await page.getByTestId('task-title').fill(42) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string | Secret'
  page.getByTestId(7) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
  await page.goto() // type-error TS2554 Expected 1 arguments, but got 0.
  await page.getByTestId('save-task').click('twice') // type-error TS2554 Expected 0 arguments, but got 1.
  const text: string = await test.step('Count', async () => 2) // type-error TS2322 Type 'number' is not assignable to type 'string'
})
