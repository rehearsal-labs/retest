import type { Responder } from '../support/api/in-process-run.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect, secret } from '../../src/index.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { appOf, inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/api-handles.test.ts'
const page = pageWithText('Release checklist')

describe('app handles', () => {
  test('a test without apps drives its default app as page, and every command names that app', async () => {
    const { runPage, sent, events } = inProcessRun(file, page, { apps: ['web'] })
    const verdict = await runPage(async ({ page: web }) => {
      await web.goto('/')
      await expect(web.getByTestId('saved-task')).toHaveText('Release checklist')
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(
      sent.map(({ app, command }) => [app, command.kind]),
      [
        ['web', 'goto'],
        ['web', 'observe'],
      ],
    )
    const assertion = events().find((event) => event.type === 'assertion.passed')
    assert.equal(assertion?.session, 'web')
  })

  test('a test with apps gets one page per app, and each routes its own commands', async () => {
    const { runTest, sent } = inProcessRun(file, page, { apps: ['owner', 'member'] })
    let keys: string[] = []
    const verdict = await runTest({
      apps: ['owner', 'member'],
      body: async (context) => {
        keys = Object.keys(context)
        await appOf(context, 'owner').getByTestId('save-task').click()
        await appOf(context, 'member').goto('/tasks')
        await expect(appOf(context, 'member').getByTestId('saved-task')).toBeVisible()
      },
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(keys, ['owner', 'member'])
    assert.deepEqual(
      sent.map(({ app, command }) => [app, command.kind]),
      [
        ['owner', 'click'],
        ['member', 'goto'],
        ['member', 'observe'],
      ],
    )
  })

  test('reading page from a test with apps names its apps', async () => {
    const { runTest } = inProcessRun(file, page, { apps: ['owner', 'member'] })
    const verdict = await runTest({ apps: ['owner', 'member'], body: (context) => context['page'] })
    assert.equal(verdict.failure?.class, 'usage')
    assert.equal(verdict.failure?.message, 'This test declares the apps owner and member, so it has no page. Take its apps by name: ({ owner, member }).')
  })

  test('an app named page is the page', async () => {
    const { runTest, sent } = inProcessRun(file, page, { apps: ['page'] })
    const verdict = await runTest({ apps: ['page'], body: (context) => appOf(context, 'page').goto('/').then(() => expect(1).toBe(1)) })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(sent.map(({ app }) => app), ['page'])
  })

  test('apps the parent opened that differ from the ones the test declares fail it before it runs', async () => {
    const declared = inProcessRun(file, page, { apps: ['owner'] })
    let ran = false
    const verdict = await declared.runTest({ apps: ['owner', 'member'], body: () => (ran = true) })
    assert.equal(verdict.failure?.class, 'test_error')
    assert.equal(verdict.failure?.message, 'Retest opened the apps owner for this test, which declares owner and member.')
    const none = await inProcessRun(file, page, { apps: ['owner', 'member'] }).runTest({ body: () => (ran = true) })
    assert.equal(none.failure?.message, 'Retest opened the apps owner and member for this test, which uses one app.')
    const empty = await inProcessRun(file, page, { apps: [] }).runTest({ body: () => (ran = true) })
    assert.equal(empty.failure?.message, 'Retest opened no app for this test, which uses one app.')
    assert.equal(ran, false)
  })
})

describe('one command at a time, for each app', () => {
  const slow: Responder = (command) =>
    new Promise((resolve) => setTimeout(() => resolve(page(command, '') ?? { ok: true, kind: 'click' }), 30))

  test('two apps may act at once', async () => {
    const { runTest, sent } = inProcessRun(file, slow, { apps: ['owner', 'member'] })
    const verdict = await runTest({
      apps: ['owner', 'member'],
      body: async (context) => {
        await Promise.all([appOf(context, 'owner').getByTestId('save-task').click(), appOf(context, 'member').getByTestId('save-task').click()])
        expect(1).toBe(1)
      },
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(sent.length, 2)
  })

  test('a second command to the same app fails at once and names the app', async () => {
    const { runTest, sent } = inProcessRun(file, slow, { apps: ['owner', 'member'] })
    const verdict = await runTest({
      apps: ['owner', 'member'],
      body: async (context) => {
        const owner = appOf(context, 'owner')
        await Promise.all([owner.getByTestId('save-task').click(), owner.getByRole('button', { name: 'Share' }).click()])
      },
    })
    assert.equal(verdict.failure?.class, 'concurrent_commands')
    assert.match(verdict.failure?.message ?? '', /sent the next command to owner\. Retest sends one command at a time to each app\. Add await on line \d+\.$/)
    assert.equal(sent.length, 1)
  })

  test('an assertion may look at one app while another acts, but not at the app that acts', async () => {
    const { runTest, events } = inProcessRun(file, slow, { apps: ['owner', 'member'] })
    const verdict = await runTest({
      apps: ['owner', 'member'],
      body: async (context) => {
        const clicking = appOf(context, 'owner').getByTestId('save-task').click()
        await expect(appOf(context, 'member').getByTestId('saved-task')).toBeVisible()
        await clicking
        const again = appOf(context, 'owner').getByTestId('save-task').click()
        await expect(appOf(context, 'owner').getByTestId('saved-task')).toBeVisible()
        await again
      },
    })
    const passed = events().flatMap((event) => (event.type === 'assertion.passed' ? [event.session] : []))
    assert.deepEqual(passed, ['member'], 'the look at member ran while owner acted')
    assert.equal(verdict.failure?.class, 'concurrent_commands')
    assert.match(verdict.failure?.message ?? '', /\(expect\(getByTestId\('saved-task'\)\)\.toBeVisible\(\)\) sent the next command to owner\./)
  })
})

describe('locators', () => {
  test('getByRole, getByLabel and getByText send their recipe, with exact only when given', async () => {
    const { runPage, commands } = inProcessRun(file, page)
    const verdict = await runPage(async ({ page: handle }) => {
      await handle.getByRole('button').click()
      await handle.getByRole('button', { name: 'Save', exact: false }).click()
      await handle.getByLabel('Title').fill('Release checklist')
      await handle.getByText('Saved', { exact: true }).tap()
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(
      commands.map((command) => ('locator' in command ? [command.kind, command.locator] : [command.kind])),
      [
        ['click', { by: 'role', role: 'button' }],
        ['click', { by: 'role', role: 'button', name: 'Save', exact: false }],
        ['fill', { by: 'label', text: 'Title' }],
        ['tap', { by: 'text', text: 'Saved', exact: true }],
      ],
    )
  })

  // Each is a call as JavaScript may make it: [what, the object, the method, its arguments, the message].
  const misuses: [string, 'page' | 'locator', string, unknown[], string][] = [
    ['an unknown role', 'page', 'getByRole', ['buton'], "getByRole() takes an ARIA role such as 'button', received 'buton'."],
    ['an unknown role option', 'page', 'getByRole', ['button', { nam: 'Save' }], "getByRole() options take name and exact, received { nam: 'Save' }."],
    ['a name that is not text', 'page', 'getByRole', ['button', { name: 3 }], 'getByRole() takes name as a string, received 3.'],
    ['an exact that is not a boolean', 'page', 'getByText', ['Saved', { exact: 'yes' }], "getByText() takes exact as true or false, received 'yes'."],
    ['text of only spaces', 'page', 'getByText', ['  '], "getByText() takes the text to find, received '  '."],
    ['a label that is not text', 'page', 'getByLabel', [3], 'getByLabel() takes the text to find, received 3.'],
    ['a goto without a URL', 'page', 'goto', [7], 'goto() takes a URL string, received 7.'],
    ['a fill that is not text', 'locator', 'fill', [42], 'fill() takes a string, received 42.'],
  ]
  for (const [what, on, method, args, message] of misuses) {
    test(`${what} from JavaScript is a usage failure that sends nothing`, async () => {
      const { runPage, commands } = inProcessRun(file, page)
      const verdict = await runPage(({ page: handle }) => callLoosely(on === 'page' ? handle : handle.getByLabel('Title'), method, args))
      assert.equal(verdict.failure?.class, 'usage')
      assert.equal(verdict.failure?.message, message)
      assert.equal(verdict.failure?.location?.file, 'tests/support/api/call-loosely.ts', 'located at the call that made it')
      assert.deepEqual(commands, [])
    })
  }

  test('a page that has no touch screen refuses tap, and the test fails with its answer', async () => {
    const refusing: Responder = (command) =>
      command.kind === 'tap' ? { ok: false, failure: { class: 'unsupported', message: 'This page has no touch screen, so it cannot tap.' } } : undefined
    const { runPage } = inProcessRun(file, refusing)
    const verdict = await runPage(({ page: handle }) => handle.getByTestId('save-task').tap())
    assert.equal(verdict.failure?.class, 'unsupported')
    assert.equal(verdict.failure?.location?.file, file)
  })

  test('filling a secret sends its name, never a value, and names it in messages', async () => {
    const { runPage, commands } = inProcessRun(file, () => undefined)
    const verdict = await runPage(async ({ page: handle }) => {
      const typing = handle.getByLabel('Password').fill(secret('password'))
      void typing.catch(() => undefined)
      await handle.getByRole('button', { name: 'Sign in' }).click()
    })
    assert.deepEqual(commands, [{ kind: 'fill', locator: { by: 'label', text: 'Password' }, value: { secret: 'password' } }])
    assert.match(verdict.failure?.message ?? '', /^Line \d+ \(getByLabel\('Password'\)\.fill\(secret\("password"\)\)\) was still running/)
  })
})

