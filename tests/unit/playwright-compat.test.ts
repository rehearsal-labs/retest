import assert from 'node:assert/strict'
import { describe, test as check } from 'node:test'
import { AppLocator } from '../../src/api/app-page.ts'
import { RetestError } from '../../src/api/failure.ts'
import { expect as playwrightExpect, test as playwrightTest } from '../../src/playwright/index.ts'
import { guard, unguarded } from '../../src/playwright/not-yet.ts'
import { fixturesOf } from '../../src/playwright/test.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/playwright-compat.test.ts'
const saved = pageWithText('Saved')
const notYet = (member: string): string => `${member} is not supported yet by Retest's Playwright compatibility.`

/** The failure message of a test whose body is `use`, each in a run of its own. */
async function failureOf(use: (page: Parameters<Parameters<ReturnType<typeof inProcessRun>['runPage']>[0]>[0]['page']) => unknown): Promise<string | undefined> {
  const verdict = await inProcessRun(file, saved).runPage(({ page }) => use(page))
  return verdict.failure?.message
}

/** What a throw gives: the failure of a `RetestError`. */
function thrownBy(work: () => unknown): RetestError {
  try {
    work()
  } catch (error) {
    assert.ok(error instanceof RetestError, String(error))
    return error
  }
  return assert.fail('nothing was thrown')
}

describe("a page under Retest's Playwright compatibility", () => {
  check('a member Retest does not have fails the test by name, as unsupported, at the line that used it', async () => {
    const { runPage } = inProcessRun(file, saved)
    const verdict = await runPage(({ page }) => {
      Reflect.get(guard(page, 'page'), 'getByPlaceholder')
    })
    assert.equal(verdict.failure?.class, 'unsupported')
    assert.equal(verdict.failure?.message, notYet('page.getByPlaceholder'))
    assert.equal(verdict.failure?.location?.file, file)
  })

  check('says what to use instead where Retest has an answer', async () => {
    assert.equal(
      await failureOf((page) => Reflect.get(guard(page, 'page').getByTestId('saved-task'), 'first')),
      `${notYet('locator.first')} A locator that matches several elements is ambiguous in Retest. Narrow it with getByRole, getByLabel, getByText or getByTestId.`,
    )
    assert.equal(
      await failureOf((page) => Reflect.get(guard(page, 'page'), 'waitForTimeout')),
      `${notYet('page.waitForTimeout')} Wait for what the page shows instead, with an assertion such as toBeVisible().`,
    )
  })

  check("the locators it returns are guarded too, and Retest's matchers take them as its own", async () => {
    const { runPage, commands } = inProcessRun(file, saved)
    const verdict = await runPage(async ({ page }) => {
      const locator = guard(page, 'page').getByTestId('saved-task')
      assert.ok(unguarded(locator) instanceof AppLocator)
      assert.notEqual(unguarded(locator), locator)
      await playwrightExpect(locator).toHaveText('Saved')
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(commands, [{ kind: 'observe', locator: { by: 'testId', value: 'saved-task' } }])
  })

  check('the keyboard is guarded as page.keyboard', async () => {
    const { runPage } = inProcessRun(file, saved)
    const verdict = await runPage(({ page }) => {
      Reflect.get(guard(page, 'page').keyboard, 'type')
    })
    assert.equal(verdict.failure?.message, notYet('page.keyboard.type'))
  })
})

describe("expect under Retest's Playwright compatibility", () => {
  check('an options argument, .not and a matcher Retest does not have each fail by name', async () => {
    const options = await failureOf((page) => {
      const matchers = playwrightExpect(guard(page, 'page').getByTestId('saved-task'))
      return Reflect.apply(Reflect.get(matchers, 'toBeVisible'), matchers, [{ timeout: 5 }])
    })
    assert.equal(options, notYet('expect().toBeVisible(…, options)'))
    assert.equal(await failureOf((page) => Reflect.get(playwrightExpect(guard(page, 'page').getByTestId('saved-task')), 'not')), notYet('expect().not'))
    assert.equal(
      await failureOf((page) => Reflect.get(playwrightExpect(guard(page, 'page').getByTestId('saved-task')), 'toContainText')),
      notYet('expect().toContainText'),
    )
  })

  check('a value takes the value matchers, and expect.soft and expect.poll are there', async () => {
    const { runPage } = inProcessRun(file, saved)
    const verdict = await runPage(async () => {
      playwrightExpect(2).toBe(2)
      playwrightExpect({ a: 1 }).toEqual({ a: 1 })
      playwrightExpect.soft('saved').toContain('save')
      await playwrightExpect.poll(() => 3).toBe(3)
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(thrownBy(() => Reflect.get(playwrightExpect, 'extend')).failure.message, notYet('expect.extend'))
  })
})

describe("test under Retest's Playwright compatibility", () => {
  check('members Playwright has and Retest does not fail by name where they are read', () => {
    assert.equal(thrownBy(() => Reflect.get(playwrightTest, 'skip')).failure.message, notYet('test.skip'))
    assert.equal(thrownBy(() => Reflect.get(playwrightTest, 'beforeAll')).failure.message, notYet('test.beforeAll'))
    assert.equal(thrownBy(() => Reflect.get(playwrightTest.describe, 'serial')).failure.message, notYet('test.describe.serial'))
    assert.equal(thrownBy(() => Reflect.get(playwrightTest, 'skip')).failure.class, 'unsupported')
  })

  check('test details and titled hooks are refused, not dropped', () => {
    assert.equal(thrownBy(() => Reflect.apply(playwrightTest, undefined, ['tagged', { tag: '@smoke' }, () => {}])).failure.message, notYet('test(title, details, body)'))
    assert.equal(thrownBy(() => Reflect.apply(playwrightTest.beforeEach, undefined, ['signs in', () => {}])).failure.message, notYet('test.beforeEach(title, body)'))
  })

  check('a fixture other than page fails by name, and page is guarded once, though the context is frozen', () => {
    const page = { goto: () => {} }
    const fixtures = fixturesOf(Object.freeze({ page }))
    assert.ok(typeof fixtures === 'object' && fixtures !== null)
    const guarded: unknown = Reflect.get(fixtures, 'page')
    assert.equal(unguarded(guarded), page)
    assert.equal(Reflect.get(fixtures, 'page'), guarded)
    assert.equal(thrownBy(() => Reflect.get(fixtures, 'browser')).failure.message, notYet('The browser fixture'))
    assert.equal(thrownBy(() => Reflect.get(fixtures, 'request')).failure.message, notYet('The request fixture'))
  })
})
