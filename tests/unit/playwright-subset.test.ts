import type { PageCommand } from '../../src/protocol/commands.ts'
import assert from 'node:assert/strict'
import { describe, test as check } from 'node:test'
import { RetestError } from '../../src/api/failure.ts'
import { expect as playwrightExpect, test as playwrightTest } from '../../src/playwright/index.ts'
import { guard } from '../../src/playwright/not-yet.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/playwright-subset.test.ts'
const saved = pageWithText('Saved')
const notYet = (member: string): string => `${member} is not supported yet by Retest's Playwright compatibility.`

type GuardedPage = ReturnType<typeof guard<Parameters<Parameters<ReturnType<typeof inProcessRun>['runPage']>[0]>[0]['page']>>

/** The commands a test body sent, each as its kind and, for a select, the options it named. */
function selects(commands: readonly PageCommand[]): unknown[] {
  return commands.map((command) => (command.kind === 'select' ? [command.kind, command.choices, command.multiple] : [command.kind]))
}

describe("selectOption under Retest's Playwright compatibility", () => {
  check('an option named by its label or by its value goes to Retest’s select, and { timeout } goes with it', async () => {
    const { runPage, commands } = inProcessRun(file, saved)
    const verdict = await runPage(async ({ page }) => {
      const guarded = guard(page, 'page')
      await callLoosely(guarded.getByLabel('Priority'), 'selectOption', [{ label: 'High' }])
      await callLoosely(guarded.getByLabel('Plan'), 'selectOption', [{ value: 'team' }, { timeout: 500 }])
      await callLoosely(guarded.getByLabel('Plan'), 'selectOption', [{ value: 'team', label: undefined }])
      await playwrightExpect(guarded.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(selects(commands), [
      ['select', [{ label: 'High' }], undefined],
      ['select', [{ value: 'team' }], undefined],
      ['select', [{ value: 'team' }], undefined],
      ['observe'],
    ])
  })

  check('a bare string, a list, an index, null, an option named two ways and an option Retest has no answer for each fail by name and send nothing', async () => {
    const cases: [string, (page: GuardedPage) => unknown][] = [
      ['locator.selectOption(text)', (page) => callLoosely(page.getByLabel('Priority'), 'selectOption', ['High'])],
      ['locator.selectOption([…])', (page) => callLoosely(page.getByLabel('Priority'), 'selectOption', [[{ label: 'High' }]])],
      ['locator.selectOption({ index })', (page) => callLoosely(page.getByLabel('Priority'), 'selectOption', [{ index: 2 }])],
      ['locator.selectOption(null)', (page) => callLoosely(page.getByLabel('Priority'), 'selectOption', [null])],
      ['locator.selectOption({ value, label })', (page) => callLoosely(page.getByLabel('Priority'), 'selectOption', [{ value: 'high', label: 'High' }])],
      ['locator.selectOption(values, { force })', (page) => callLoosely(page.getByLabel('Priority'), 'selectOption', [{ label: 'High' }, { force: true }])],
      ['locator.selectOption(values, options, …)', (page) => callLoosely(page.getByLabel('Priority'), 'selectOption', [{ label: 'High' }, {}, 'extra'])],
    ]
    for (const [member, use] of cases) {
      const { runPage, commands } = inProcessRun(file, saved)
      const verdict = await runPage(({ page }) => use(guard(page, 'page')))
      assert.equal(verdict.failure?.class, 'unsupported', member)
      assert.ok(verdict.failure?.message.startsWith(notYet(member)), `${member}: ${verdict.failure?.message}`)
      assert.deepEqual(commands, [], `${member} sent nothing`)
    }
  })

  check('a bare string says why it is refused and what to write instead', async () => {
    const { runPage } = inProcessRun(file, saved)
    const verdict = await runPage(({ page }) => callLoosely(guard(page, 'page').getByLabel('Priority'), 'selectOption', ['High']))
    assert.equal(
      verdict.failure?.message,
      `${notYet('locator.selectOption(text)')} Playwright matches the text against each option's value and its label at once, and Retest has to know which. Name the option with { label } or { value }.`,
    )
  })

  check('a locator says it has selectOption, and anything other than an option object goes to Retest’s own check', async () => {
    const { runPage, commands } = inProcessRun(file, saved)
    const verdict = await runPage(async ({ page }) => {
      const locator = guard(page, 'page').getByLabel('Priority')
      assert.ok('selectOption' in locator)
      await callLoosely(locator, 'selectOption', [42])
    })
    assert.equal(verdict.failure?.class, 'usage')
    assert.match(verdict.failure?.message ?? '', /^select\(\) takes an option's label/)
    assert.deepEqual(commands, [])
  })
})

describe("what Playwright's calls answer and Retest's do not", () => {
  check('the values selectOption answers and the response goto answers fail by name when read, at the line that reads them', async () => {
    for (const [member, use] of [
      ['The values locator.selectOption() returns', async (page: GuardedPage) => Reflect.get(Object(await callLoosely(page.getByLabel('Plan'), 'selectOption', [{ label: 'Team' }])), 'length')],
      ['The response page.goto() returns', async (page: GuardedPage) => Reflect.get(Object(await page.goto('/')), 'status')],
      ['The response page.reload() returns', async (page: GuardedPage) => Reflect.get(Object(await page.reload()), 'ok')],
      ['The response page.goBack() returns', async (page: GuardedPage) => Reflect.get(Object(await page.goBack()), 'url')],
      ['The response page.goForward() returns', async (page: GuardedPage) => Reflect.get(Object(await page.goForward()), 'headers')],
    ] as const) {
      const { runPage, commands } = inProcessRun(file, saved)
      const verdict = await runPage(({ page }) => use(guard(page, 'page')))
      assert.equal(verdict.failure?.class, 'unsupported', member)
      assert.equal(verdict.failure?.message, notYet(member))
      assert.equal(verdict.failure?.location?.file, file)
      assert.equal(commands.length, 1, `${member}: the call itself was sent once`)
    }
  })

  check('a test that awaits a call and leaves its answer alone passes, and printing or serialising the answer finds nothing', async () => {
    const { runPage, commands } = inProcessRun(file, saved)
    const verdict = await runPage(async ({ page }) => {
      const guarded = guard(page, 'page')
      const response = await guarded.goto('/')
      assert.equal(JSON.stringify(response), '{}')
      assert.equal(typeof response, 'object')
      const caught = await guarded.reload().catch(() => 'rejected')
      assert.notEqual(caught, 'rejected')
      await Promise.all([callLoosely(guarded.getByLabel('Plan'), 'selectOption', [{ value: 'team' }])])
      await playwrightExpect(guarded.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(commands.map((command) => command.kind), ['goto', 'reload', 'select', 'observe'])
  })

  check('a call nothing awaited is still reported as not awaited', async () => {
    const { runPage } = inProcessRun(file, saved)
    const verdict = await runPage(({ page }) => {
      void guard(page, 'page').goto('/')
    })
    assert.equal(verdict.failure?.class, 'not_awaited', verdict.failure?.message)
  })
})

describe("a row by name under Retest's Playwright compatibility", () => {
  check('is refused by name on a page and on a locator, and says what to do instead; a row by position and other roles by name are not', async () => {
    const hint = "Chrome's accessibility tree gives a table row no name from its cells, where Playwright names it from them. Take the row by position with nth(), or find a cell by name."
    for (const [member, use] of [
      ['page.getByRole(row, { name })', (page: GuardedPage) => page.getByRole('row', { name: 'Grace Hopper' })],
      ['locator.getByRole(row, { name })', (page: GuardedPage) => page.getByTestId('team').getByRole('row', { name: /Grace/ })],
    ] as const) {
      const { runPage, commands } = inProcessRun(file, saved)
      const verdict = await runPage(({ page }) => use(guard(page, 'page')))
      assert.equal(verdict.failure?.class, 'unsupported')
      assert.equal(verdict.failure?.message, `${notYet(member)} ${hint}`)
      assert.deepEqual(commands, [])
    }
    const { runPage, commands } = inProcessRun(file, saved)
    const verdict = await runPage(async ({ page }) => {
      const guarded = guard(page, 'page')
      await guarded.getByRole('row').nth(2).getByRole('cell', { name: 'Grace Hopper' }).click()
      await guarded.getByRole('columnheader', { name: 'Role' }).click()
      await playwrightExpect(guarded.getByTestId('saved-task')).toBeVisible()
    })
    assert.equal(verdict.status, 'passed', verdict.failure?.message)
    assert.deepEqual(commands.map((command) => command.kind), ['click', 'click', 'observe'])
  })
})

describe("what a saved sign-in state needs under Retest's Playwright compatibility", () => {
  // Workflow family 3 stays out of the comparison's corpus for these two refusals.
  check('test.use and page.context fail by name', async () => {
    let refusal: unknown
    try {
      Reflect.get(playwrightTest, 'use')
    } catch (error) {
      refusal = error
    }
    assert.ok(refusal instanceof RetestError)
    assert.equal(refusal.failure.message, notYet('test.use'))
    const { runPage, commands } = inProcessRun(file, saved)
    const verdict = await runPage(({ page }) => Reflect.get(guard(page, 'page'), 'context'))
    assert.deepEqual([verdict.failure?.class, verdict.failure?.message], ['unsupported', notYet('page.context')])
    assert.deepEqual(commands, [])
  })
})
