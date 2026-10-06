import type { Alert, NativeKeyboard, NativeLocatorStep, NativeStepPick, SwipeDirection } from '../../src/index.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expect } from '../../src/index.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

// The types of a native app's helpers, as a test file imports them from the package. Each one types a value a helper
// takes or a handle a test keeps, so the typecheck fails when one of them is not exported.

const file = 'tests/unit/index-native-types.test.ts'

test("the native helpers' types come from the package and type what a test passes and keeps", async () => {
  const run = inProcessRun(file, pageWithText('Release checklist'))
  const verdict = await run.runPage(async ({ page }) => {
    const pick: NativeStepPick = 'last'
    const step: NativeLocatorStep = { by: 'role', role: 'button', name: 'Save', pick }
    const direction: SwipeDirection = 'up'
    const keyboard: NativeKeyboard<'ios-simulator'> = page.keyboard
    const alert: Alert = page.alert
    await page.locator(step).tap()
    await page.swipe(direction)
    await keyboard.wait()
    await alert.accept('Allow')
    expect(1).toBe(1)
  })
  assert.equal(verdict.status, 'passed', verdict.failure?.message)
  assert.deepEqual(run.commands, [
    { kind: 'tap', locator: { by: 'role', role: 'button', name: 'Save', pick: 'last' } },
    { kind: 'swipe', direction: 'up' },
    { kind: 'nativeKeyboard', operation: 'wait' },
    { kind: 'nativeAlert', operation: 'accept', button: 'Allow' },
  ])
})
