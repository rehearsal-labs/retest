import assert from 'node:assert/strict'
import { describe, test as check } from 'node:test'
import { AppLocator } from '../../src/api/app-page.ts'
import { RetestError } from '../../src/api/failure.ts'
import { expect as playwrightExpect, test as playwrightTest } from '../../src/playwright/index.ts'
import { guard, unguarded } from '../../src/playwright/not-yet.ts'
import { fixturesOf } from '../../src/playwright/test.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/playwright-compat.test.ts'
const saved = pageWithText('Saved')
const notYet = (member: string): string => `${member} is not supported yet by Retest's Playwright compatibility.`

/** The failure message of a test whose body is `use`, each in a run of its own. */
async function failureOf(use: (page: Parameters<Parameters<ReturnType<typeof inProcessRun>['runPage']>[0]>[0]['page']) => unknown): Promise<string | undefined> {
  const verdict = await inProcessRun(file, saved).runPage(({ page }) => use(page))
  return verdict.failure?.message
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
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
      Reflect.get(guard(page, 'page'), 'getByAltText')
    })
    assert.equal(verdict.failure?.class, 'unsupported')
    assert.equal(verdict.failure?.message, notYet('page.getByAltText'))
    assert.equal(verdict.failure?.location?.file, file)
  })

  check('says what to use instead where Retest has an answer', async () => {
    assert.equal(
      await failureOf((page) => Reflect.get(guard(page, 'page').getByTestId('saved-task'), 'filter')),
      `${notYet('locator.filter')} Find inside a locator with getByRole, getByText or locator(), or keep one match with first(), last() or nth().`,
    )
    assert.equal(
      await failureOf((page) => Reflect.get(guard(page, 'page'), 'url')),
      `${notYet('page.url')} Playwright reads it at once, and Retest has to ask the page. Check it with expect(page).toHaveURL().`,
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
    assert.deepEqual(commands, [{ kind: 'observe', locator: { by: 'testId', value: 'saved-task' }, check: true }])
  })

  check("Playwright's options Retest has no answer for fail by name, and a timeout goes to Retest's own", async () => {
    const cases: [string, (page: ReturnType<typeof guard<Parameters<Parameters<ReturnType<typeof inProcessRun>['runPage']>[0]>[0]['page']>>) => unknown][] = [
      ['page.goto(url, { waitUntil })', (page) => callLoosely(page, 'goto', ['/', { waitUntil: 'load' }])],
      ['locator.click({ force })', (page) => callLoosely(page.getByTestId('save'), 'click', [{ force: true }])],
      ['locator.fill(value, { noWaitAfter })', (page) => callLoosely(page.getByTestId('title'), 'fill', ['x', { noWaitAfter: true }])],
      ['locator.press(key, { delay })', (page) => callLoosely(page.getByTestId('title'), 'press', ['Enter', { delay: 10 }])],
      ['page.keyboard.press(key, { delay })', (page) => callLoosely(page.keyboard, 'press', ['Enter', { delay: 10 }])],
      ['page.getByRole(role, { level })', (page) => callLoosely(page, 'getByRole', ['heading', { level: 2 }])],
      ['page.locator(selector, { hasText })', (page) => callLoosely(page, 'locator', ['li', { hasText: 'x' }])],
      ['page.goto(url, options, …)', (page) => Reflect.apply(Reflect.get(page, 'goto'), page, ['/', {}, 'extra'])],
    ]
    for (const [member, use] of cases) {
      const { runPage, commands } = inProcessRun(file, saved)
      const verdict = await runPage(({ page }) => use(guard(page, 'page')))
      assert.equal(verdict.failure?.message, notYet(member), member)
      assert.deepEqual(commands, [], `${member} sent nothing`)
    }
    const { runPage, sent } = inProcessRun(file, saved)
    const timed = await runPage(async ({ page }) => {
      const guarded = guard(page, 'page')
      await guarded.getByTestId('save').click({ timeout: 100 })
      await guarded.goto('/', { timeout: 100 })
      await playwrightExpect(guarded.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(timed.status, 'passed', timed.failure?.message)
    assert.deepEqual(sent.map(({ command }) => command.kind), ['click', 'goto', 'observe'])
  })

  check("Playwright's members this release added run under its names, and exact beside a RegExp is left out as Playwright ignores it", async () => {
    const { runPage, sent } = inProcessRun(file, saved)
    const verdict = await runPage(async ({ page }) => {
      const guarded = guard(page, 'page')
      await guarded.getByPlaceholder('Title').fill('x')
      await guarded.locator('.task').first().hover()
      const exactText: unknown = callLoosely(guarded.getByTestId('list').getByRole('listitem').nth(1), 'getByText', [/save/i, { exact: true }])
      await callLoosely(exactText, 'click', [])
      const lastDelete: unknown = callLoosely(callLoosely(guarded, 'getByRole', ['button', { name: /^Del/, exact: false }]), 'last', [])
      await callLoosely(lastDelete, 'click', [])
      await guarded.reload()
      await guarded.goBack()
      await guarded.goForward()
      await playwrightExpect(guarded.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(
      sent.map(({ command }) => ('locator' in command ? [command.kind, command.locator] : [command.kind])),
      [
        ['fill', { by: 'placeholder', text: 'Title', exact: false }],
        ['hover', { by: 'css', selector: '.task', pick: 'first' }],
        ['click', { by: 'text', text: { pattern: 'save', flags: 'i' }, within: [{ by: 'testId', value: 'list' }, { by: 'role', role: 'listitem', pick: 1 }] }],
        ['click', { by: 'role', role: 'button', name: { pattern: '^Del', flags: '' }, pick: 'last' }],
        ['reload'],
        ['goBack'],
        ['goForward'],
        ['observe', { by: 'testId', value: 'saved-task' }],
      ],
    )
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
  check('an option other than timeout, .not on a value and a matcher Retest does not have each fail by name', async () => {
    const options = await failureOf((page) => {
      const matchers = playwrightExpect(guard(page, 'page').getByTestId('saved-task'))
      return Reflect.apply(Reflect.get(matchers, 'toHaveText'), matchers, ['Saved', { ignoreCase: true }])
    })
    assert.equal(options, notYet('expect().toHaveText(…, { ignoreCase })'))
    assert.equal(await failureOf(() => Reflect.get(playwrightExpect(3), 'not')), notYet('expect(value).not'))
    assert.equal(
      await failureOf((page) => Reflect.get(playwrightExpect(guard(page, 'page').getByTestId('saved-task')), 'toHaveAttribute')),
      notYet('expect().toHaveAttribute'),
    )
    assert.equal(
      await failureOf((page) => callLoosely(playwrightExpect(guard(page, 'page').getByTestId('saved-task')), 'toContainText', [['Sav']])),
      notYet('expect().toContainText([…])'),
    )
  })

  check('a locator and a page take the matchers this release added, .not and a timeout, as an unchanged file writes them', async () => {
    const answers = (command: Parameters<typeof saved>[0]) => {
      if (command.kind === 'observePage') return { ok: true, kind: 'observePage', observation: { url: 'http://127.0.0.1:4173/tasks', title: 'Tasks' }, baseUrl: 'http://127.0.0.1:4173/' } as const
      return saved(command, 'page')
    }
    const { runPage, commands } = inProcessRun(file, answers)
    const verdict = await runPage(async ({ page }) => {
      const guarded = guard(page, 'page')
      await playwrightExpect(guarded.getByTestId('saved-task')).toContainText('Sav', { timeout: 500 })
      await playwrightExpect(guarded.getByTestId('saved-task')).not.toHaveText('Draft')
      await playwrightExpect(guarded.getByTestId('saved-task')).toHaveText(/^Sav/)
      await playwrightExpect(guarded).toHaveURL('/tasks')
      await playwrightExpect(guarded).not.toHaveTitle('Login')
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(commands.map((command) => command.kind), ['observe', 'observe', 'observe', 'observePage', 'observePage'])
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

  check("test.step's options are refused, not dropped", () => {
    assert.equal(thrownBy(() => Reflect.apply(playwrightTest.step, undefined, ['saves', () => {}, { box: true }])).failure.message, notYet('test.step(title, body, options)'))
  })

  check('test details and titled hooks are refused, not dropped', () => {
    assert.equal(thrownBy(() => Reflect.apply(playwrightTest, undefined, ['tagged', { tag: '@smoke' }, () => {}])).failure.message, notYet('test(title, details, body)'))
    assert.equal(thrownBy(() => Reflect.apply(playwrightTest.beforeEach, undefined, ['signs in', () => {}])).failure.message, notYet('test.beforeEach(title, body)'))
  })

  check("the page fixture finds by Playwright's rules: any part of a text in any case unless exact is true, and every locator from it, chained or picked, says so", async () => {
    const { runPage, sent } = inProcessRun(file, saved)
    const verdict = await runPage(async (context) => {
      const fixtures = fixturesOf(context)
      const page: unknown = isObject(fixtures) ? Reflect.get(fixtures, 'page') : undefined
      await callLoosely(callLoosely(page, 'getByText', ['saved']), 'click', [])
      await callLoosely(callLoosely(page, 'getByLabel', ['Title', { exact: true }]), 'click', [])
      await callLoosely(callLoosely(page, 'getByRole', ['button', { name: 'Delete' }]), 'click', [])
      await callLoosely(callLoosely(page, 'getByRole', ['listitem']), 'click', [])
      const inside: unknown = callLoosely(callLoosely(page, 'getByTestId', ['list']), 'getByPlaceholder', ['Name'])
      await callLoosely(callLoosely(inside, 'first', []), 'click', [])
      await callLoosely(callLoosely(page, 'locator', ['.task']), 'click', [])
      playwrightExpect(sent.length).toBe(6)
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(
      sent.map(({ command }) => ('locator' in command ? command.locator : undefined)),
      [
        { by: 'text', text: 'saved', exact: false, dialect: 'playwright' },
        { by: 'label', text: 'Title', exact: true, dialect: 'playwright' },
        { by: 'role', role: 'button', name: 'Delete', exact: false, dialect: 'playwright' },
        { by: 'role', role: 'listitem', dialect: 'playwright' },
        { by: 'placeholder', text: 'Name', exact: false, pick: 'first', within: [{ by: 'testId', value: 'list' }], dialect: 'playwright' },
        { by: 'css', selector: '.task', dialect: 'playwright' },
      ],
    )
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
