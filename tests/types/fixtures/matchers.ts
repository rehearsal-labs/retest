import { expect, secret, test } from '@rehearsal-labs/retest'

// Every matcher's argument is typed by what it checks. Each marked line fails the type check.
test('value matchers', async ({ page }) => {
  const task = { title: 'Release checklist', done: false }
  const tags: readonly string[] = ['smoke']
  const count: number = 2
  expect(task).toEqual({ title: 'Release checklist', done: true })
  expect(new Map([['a', 1]])).toEqual(new Map([['a', 1]]))
  expect(tags).toContain('smoke')
  expect('Release checklist').toContain('Release')
  expect('Release checklist').toMatch(/release/i)
  expect(task).toEqual({ title: 'Release checklist', done: false, extra: 1 }) // type-error TS2353 'extra' does not exist in type '{ title: string; done: boolean; }'
  expect(task).toEqual({ title: 'Release checklist', done: 'no' }) // type-error TS2322 Type 'string' is not assignable to type 'boolean'
  expect(count).toEqual('2') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'number'
  expect(tags).toContain(3) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
  expect('Release checklist').toContain(/Release/) // type-error TS2345 Argument of type 'RegExp' is not assignable to parameter of type 'string'
  expect(count).toContain(2) // type-error TS2349 RetestTypeError<"toContain looks in a string or an array.">
  expect('Release checklist').toMatch('Release') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'RegExp'
  expect(count).toMatch(/2/) // type-error TS2349 RetestTypeError<"toMatch is for strings.">
  await expect(count).toBeHidden() // type-error TS2349 RetestTypeError<"toBeHidden is for locators. Use toBe on a value.">
  await expect(count).toHaveCount(2) // type-error TS2349 RetestTypeError<"toHaveCount is for locators. Use toBe on a value.">
  await expect(page.getByRole('listitem')).toHaveCount(2)
})

test('locator matchers', async ({ page }) => {
  const items = page.getByRole('listitem')
  await expect(items).toHaveText(['One', 'Two'])
  await expect(items).toHaveCount(2)
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByLabel('Title')).toHaveValue('Release checklist')
  await expect(items).toHaveText(['One', 2]) // type-error TS2322 Type 'number' is not assignable to type 'string'
  await expect(items).toHaveCount('2') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'number'
  await expect(page.getByLabel('Title')).toHaveValue(3) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
  await expect(page.getByLabel('Password')).toHaveValue(secret('password')) // type-error TS2345 Argument of type 'Secret' is not assignable to parameter of type 'string'
  expect(items).toEqual(['One']) // type-error TS2349 RetestTypeError<"toEqual is for values. Use toHaveText on a locator.">
  expect(items).toContain('One') // type-error TS2349 RetestTypeError<"toContain is for values. Use toHaveText on a locator.">
})

test('secrets', async ({ page }) => {
  const password = secret('password')
  await page.getByLabel('Password').fill(password)
  expect(password).toBe('hunter2') // type-error TS2339 Property 'toBe' does not exist on type 'RetestTypeError<"A secret cannot be compared or printed.">'
  expect.soft(password).toBe('hunter2') // type-error TS2339 A secret cannot be compared or printed.
  const text: string = password // type-error TS2322 Type 'Secret' is not assignable to type 'string'
  await page.getByLabel('Title').fill(text)
})

test('soft and poll', async ({ page }) => {
  await expect.soft(page.getByTestId('task-count')).toHaveText('2')
  expect.soft(2).toBe(2)
  expect.soft(2).toBe('2') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'number'
  await expect.poll(() => 3).toBe(3)
  await expect.poll(async () => 'saved', { timeout: 10_000, intervals: [100, 500] }).toMatch(/saved/)
  await expect.poll(async () => ['smoke']).toContain('smoke')
  await expect.poll(async () => ({ status: 200 })).toEqual({ status: 200 })
  await expect.poll(() => 3).toBe('3') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'number'
  await expect.poll(() => 3, { timeout: '5s' }).toBe(3) // type-error TS2322 Type 'string' is not assignable to type 'number'
  await expect.poll(() => page.getByTestId('saved-task')).toBe(undefined) // type-error TS2339 RetestTypeError<"expect.poll() reads values. Pass the locator to expect() instead.">
  await expect.poll(() => {
    throw new Error('never returns')
  }).toBe(1) // type-error TS2339 RetestTypeError<"expect.poll() needs a function that returns a value.">
  await expect.poll(() => 3).toBeVisible() // type-error TS2339 Property 'toBeVisible' does not exist on type 'PollAssertions<number>'
})
