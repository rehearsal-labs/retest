import { setTimeout as sleep } from 'node:timers/promises'
import { expect, test } from '@rehearsal-labs/retest'

test('never awaits an assertion', async ({ page }) => {
  void expect(page.getByTestId('save-task')).toBeVisible()
  expect(1).toBe(1)
})

test('lets a failed assertion go unawaited', async ({ page }) => {
  const check = expect(page.getByTestId('missing')).toBeVisible()
  await Promise.race([check, sleep(400)])
  expect(1).toBe(1)
})

test('catches a failed assertion', async ({ page }) => {
  await expect(page.getByTestId('missing')).toBeVisible().catch(() => undefined)
  expect(1).toBe(1)
})

test('returns while an action runs', async ({ page }) => {
  page.getByTestId('missing').click().catch(() => undefined)
  expect(1).toBe(1)
})

test('never awaits an action', async ({ page }) => {
  void page.getByTestId('save-task').click()
  await sleep(200)
  expect(1).toBe(1)
})

test('leaves a rejection unhandled', async () => {
  void Promise.reject(new RangeError('nobody handled this'))
  expect(1).toBe(1)
})
