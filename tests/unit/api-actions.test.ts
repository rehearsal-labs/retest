import type { AppPage } from '../../src/api/app-page.ts'
import type { Responder } from '../support/api/in-process-run.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { appOf, inProcessRun, pageWithText } from '../support/api/in-process-run.ts'

const file = 'tests/unit/api-actions.test.ts'
const page = pageWithText('Release checklist')
const search = { by: 'label', text: 'Search' } as const

describe('press', () => {
  test('a locator presses its key on its element, and the keyboard on whatever holds the focus', async () => {
    const { runPage, messages } = inProcessRun(file, page)
    const verdict = await runPage(async ({ page: handle }) => {
      await handle.getByLabel('Search').press('Enter')
      await handle.keyboard.press('Shift+Tab')
      await handle.keyboard.press('é')
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed')
    const sent = messages.flatMap((message) => (message.type === 'command' ? [message] : []))
    assert.deepEqual(
      sent.map(({ command }) => command),
      [
        { kind: 'press', locator: search, key: 'Enter' },
        { kind: 'press', key: 'Shift+Tab' },
        { kind: 'press', key: 'é' },
      ],
    )
    assert.deepEqual(
      sent.map(({ timeoutMs, location }) => [timeoutMs, location?.file]),
      [
        [500, file],
        [500, file],
        [500, file],
      ],
      "each press has the action's budget and its line in the test",
    )
  })

  test('a shortcut with modifiers is sent as the test wrote it, on a locator and on the keyboard', async () => {
    const { runPage, sent } = inProcessRun(file, page)
    const verdict = await runPage(async ({ page: handle }) => {
      await handle.getByLabel('Search').press('Control+A')
      await handle.keyboard.press('Meta+Shift+Z')
      await handle.keyboard.press('ControlOrMeta+Enter')
      await handle.keyboard.press('Alt++')
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(
      sent.map(({ command }) => command),
      [
        { kind: 'press', locator: search, key: 'Control+A' },
        { kind: 'press', key: 'Meta+Shift+Z' },
        { kind: 'press', key: 'ControlOrMeta+Enter' },
        { kind: 'press', key: 'Alt++' },
      ],
    )
  })

  test("each app's keyboard sends to that app", async () => {
    const { runTest, sent } = inProcessRun(file, page, { apps: ['owner', 'member'] })
    const verdict = await runTest({
      apps: ['owner', 'member'],
      body: async (context) => {
        await appOf(context, 'member').keyboard.press('Escape')
        await appOf(context, 'owner').getByLabel('Search').press('a')
        expect(1).toBe(1)
      },
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(sent, [
      { app: 'member', command: { kind: 'press', key: 'Escape' } },
      { app: 'owner', command: { kind: 'press', locator: search, key: 'a' } },
    ])
  })

  // Each is a key the test process refuses before it sends anything: [what, the key, the class, the message].
  const refusals: [string, unknown, string, string | RegExp][] = [
    [
      'an unknown name',
      'Entr',
      'usage',
      'press() takes a named key (Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp or PageDown), one character, such as a, 7 or é, or modifiers and a key, such as Control+A, Shift+Tab or Meta+Shift+Z, received "Entr".',
    ],
    ['an unknown modifier', 'Ctrl+a', 'usage', 'press() takes the modifiers Shift, Control, Alt, Meta or ControlOrMeta before a key, received "Ctrl+a".'],
    ['a modifier twice', 'Control+Control+a', 'usage', 'press() takes each modifier once, received "Control+Control+a".'],
    [
      'Shift with a character',
      'Shift+a',
      'usage',
      'Shift+ goes with a named key, or with Control, Alt or Meta, received "Shift+a". For an uppercase letter, press the letter itself, such as A.',
    ],
    ['a space', ' ', 'usage', /^press\(\) takes a named key .* received " "\.$/],
    ['no key', '', 'usage', /^press\(\) takes a named key .* received ""\.$/],
    ['a key that is not text', 13, 'usage', "press() takes a key as text, such as 'Enter', received 13."],
  ]
  for (const [what, key, kind, message] of refusals) {
    for (const on of ['locator', 'keyboard'] as const) {
      test(`${what} on the ${on} is refused at the call and never sent`, async () => {
        const { runPage, commands } = inProcessRun(file, page)
        const verdict = await runPage(({ page: handle }) =>
          callLoosely(on === 'locator' ? handle.getByLabel('Search') : handle.keyboard, 'press', [key]),
        )
        assert.deepEqual(commands, [])
        assert.equal(verdict.failure?.class, kind)
        if (typeof message === 'string') assert.equal(verdict.failure?.message, message)
        else assert.match(verdict.failure?.message ?? '', message)
        assert.equal(verdict.failure?.location?.file, 'tests/support/api/call-loosely.ts', 'located at the call that made it')
      })
    }
  }

  test("the parent's refusal fails the test at the press, which is sent once", async () => {
    const lost: Responder = (command) =>
      command.kind === 'press' ? { ok: false, failure: { class: 'outcome_unknown', message: 'The browser closed while the key was down.' } } : undefined
    const { runPage, commands } = inProcessRun(file, lost)
    const verdict = await runPage(({ page: handle }) => handle.keyboard.press('Enter'))
    assert.equal(verdict.failure?.class, 'outcome_unknown')
    assert.equal(verdict.failure?.location?.file, file)
    assert.equal(commands.length, 1, 'a press is never sent again')
  })

  test('a press while another command runs on its app fails at once and names both', async () => {
    const slow: Responder = (command) => new Promise((resolve) => setTimeout(() => resolve(page(command, '') ?? { ok: true, kind: 'press' }), 30))
    const { runPage, commands } = inProcessRun(file, slow)
    const verdict = await runPage(async ({ page: handle }) => {
      await Promise.all([handle.getByLabel('Search').press('Enter'), handle.keyboard.press('Tab')])
    })
    assert.equal(verdict.failure?.class, 'concurrent_commands')
    assert.match(verdict.failure?.message ?? '', /\(getByLabel\('Search'\)\.press\('Enter'\)\) was still running when line \d+ \(page\.keyboard\.press\('Tab'\)\) sent/)
    assert.equal(commands.length, 1)
  })

  test('a press still running when the test returns fails it', async () => {
    const { runPage } = inProcessRun(file, () => undefined)
    const verdict = await runPage(({ page: handle }) => {
      handle.keyboard.press('Enter').catch(() => undefined)
      expect(1).toBe(1)
    })
    assert.equal(verdict.failure?.class, 'not_awaited')
    assert.match(verdict.failure?.message ?? '', /^page\.keyboard\.press\('Enter'\) on line \d+ was still running when the test returned\./)
  })

  test('a press inside the function expect.poll calls is refused, since it would run on every look', async () => {
    const { runPage, commands } = inProcessRun(file, page)
    const verdict = await runPage(({ page: handle }) => expect.poll(() => handle.keyboard.press('ArrowDown').then(() => 1)).toBe(1))
    assert.deepEqual(commands, [])
    assert.equal(verdict.failure?.class, 'usage')
    assert.match(verdict.failure?.message ?? '', /page\.keyboard\.press\('ArrowDown'\) on line \d+ would run again each time\.$/)
  })
})

const country = { by: 'label', text: 'Country' } as const
const remember = { by: 'label', text: 'Remember me' } as const
const terms = { by: 'testId', value: 'terms' } as const

describe('select', () => {
  test('a label and a value choose one option, and a list, even of one, says it is a list', async () => {
    const { runPage, messages } = inProcessRun(file, page)
    const verdict = await runPage(async ({ page: handle }) => {
      await handle.getByLabel('Country').select('Canada')
      await handle.getByLabel('Country').select({ value: 'ca' })
      await handle.getByLabel('Country').select('')
      await handle.getByLabel('Country').select(['Red', { value: 'b' }])
      await handle.getByLabel('Country').select(['Red'])
      await handle.getByLabel('Country').select(Object.freeze(['Red', 'Red']))
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed')
    const sent = messages.flatMap((message) => (message.type === 'command' ? [message] : []))
    assert.deepEqual(
      sent.map(({ command }) => command),
      [
        { kind: 'select', locator: country, choices: [{ label: 'Canada' }] },
        { kind: 'select', locator: country, choices: [{ value: 'ca' }] },
        { kind: 'select', locator: country, choices: [{ label: '' }] },
        { kind: 'select', locator: country, choices: [{ label: 'Red' }, { value: 'b' }], multiple: true },
        { kind: 'select', locator: country, choices: [{ label: 'Red' }], multiple: true },
        { kind: 'select', locator: country, choices: [{ label: 'Red' }, { label: 'Red' }], multiple: true },
      ],
    )
    assert.deepEqual(
      sent.map(({ timeoutMs, location }) => [timeoutMs, location?.file]),
      Array.from({ length: 6 }, () => [500, file]),
      "each select has the action's budget and its line in the test",
    )
  })

  const shape = "select() takes an option's label, such as 'Canada', its value, such as { value: 'ca' }, or a list of these"
  // Each is a choice the test process refuses before it sends anything: [what, the argument, the message].
  const refusals: [string, unknown, string][] = [
    ['a number', 1, `${shape}, received 1.`],
    ['nothing', undefined, `${shape}, received undefined.`],
    ['null', null, `${shape}, received null.`],
    ['an option by its label written as an object', { label: 'Canada' }, `${shape}, received { label: 'Canada' }.`],
    ['a value that is not text', { value: 3 }, `${shape}, received { value: 3 }.`],
    ['a value beside another key', { value: 'ca', label: 'Canada' }, `${shape}, received { value: 'ca', label: 'Canada' }.`],
    ['a list holding something else', ['Red', 3], `${shape}, received [ 'Red', 3 ].`],
    ['a list inside a list', [['Red']], `${shape}, received [ [ 'Red' ] ].`],
    ['an empty list', [], 'select() needs at least one option, received an empty list.'],
  ]
  for (const [what, argument, message] of refusals) {
    test(`${what} is refused at the call and never sent`, async () => {
      const { runPage, commands } = inProcessRun(file, page)
      const verdict = await runPage(({ page: handle }) => callLoosely(handle.getByLabel('Country'), 'select', [argument]))
      assert.deepEqual(commands, [])
      assert.equal(verdict.failure?.class, 'usage')
      assert.equal(verdict.failure?.message, message)
      assert.equal(verdict.failure?.location?.file, 'tests/support/api/call-loosely.ts', 'located at the call that made it')
    })
  }

  test('a list of one is named as the list the test wrote', async () => {
    const slow: Responder = (command) => new Promise((resolve) => setTimeout(() => resolve(page(command, '') ?? { ok: true, kind: 'click' }), 30))
    const { runPage, commands } = inProcessRun(file, slow)
    const verdict = await runPage(async ({ page: handle }) => {
      await Promise.all([handle.getByLabel('Country').select(['Canada']), handle.getByLabel('Country').select('Canada')])
    })
    assert.equal(verdict.failure?.class, 'concurrent_commands')
    assert.match(
      verdict.failure?.message ?? '',
      /\(getByLabel\('Country'\)\.select\(\['Canada'\]\)\) was still running when line \d+ \(getByLabel\('Country'\)\.select\('Canada'\)\) sent/,
    )
    assert.equal(commands.length, 1)
  })
})

describe('check and uncheck', () => {
  test('each sends its element, to its own app', async () => {
    const { runTest, sent } = inProcessRun(file, page, { apps: ['owner', 'member'] })
    const verdict = await runTest({
      apps: ['owner', 'member'],
      body: async (context) => {
        await appOf(context, 'owner').getByLabel('Remember me').check()
        await appOf(context, 'member').getByLabel('Remember me').uncheck()
        expect(1).toBe(1)
      },
    })
    assert.equal(verdict.status, 'passed')
    assert.deepEqual(sent, [
      { app: 'owner', command: { kind: 'check', locator: remember } },
      { app: 'member', command: { kind: 'uncheck', locator: remember } },
    ])
  })

  test('an element already as asked passes, since the parent answers that nothing changed', async () => {
    const unchanged: Responder = (command) =>
      command.kind === 'check' || command.kind === 'uncheck' ? { ok: true, kind: command.kind, changed: false } : page(command, '')
    const { runPage, commands } = inProcessRun(file, unchanged)
    const verdict = await runPage(async ({ page: handle }) => {
      await handle.getByLabel('Remember me').check()
      await handle.getByLabel('Remember me').uncheck()
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(commands.length, 2)
  })
})

describe('scroll', () => {
  test('a locator turns the wheel on its element and the page at its centre, with 0 for an axis not given', async () => {
    const { runPage, messages } = inProcessRun(file, page)
    const verdict = await runPage(async ({ page: handle }) => {
      await handle.getByTestId('terms').scroll({ y: 600 })
      await handle.scroll({ x: -40.5 })
      await handle.scroll({ x: 120, y: undefined })
      await handle.getByTestId('terms').scroll({ x: 0, y: -1200 })
      expect(1).toBe(1)
    })
    assert.equal(verdict.status, 'passed')
    const sent = messages.flatMap((message) => (message.type === 'command' ? [message] : []))
    assert.deepEqual(
      sent.map(({ command }) => command),
      [
        { kind: 'scroll', locator: terms, x: 0, y: 600 },
        { kind: 'scroll', x: -40.5, y: 0 },
        { kind: 'scroll', x: 120, y: 0 },
        { kind: 'scroll', locator: terms, x: 0, y: -1200 },
      ],
    )
    assert.deepEqual(
      sent.map(({ timeoutMs }) => timeoutMs),
      [500, 500, 500, 500],
      "each scroll has the action's budget",
    )
  })

  const shape = 'scroll() takes x and y in CSS pixels, such as { y: 600 }'
  // Each is a delta the test process refuses before it sends anything: [what, the argument, the message].
  const refusals: [string, unknown, string][] = [
    ['no distance', {}, 'scroll() takes x and y in CSS pixels, one of them other than 0, received { x: 0, y: 0 }.'],
    ['zero on both axes', { x: 0, y: 0 }, 'scroll() takes x and y in CSS pixels, one of them other than 0, received { x: 0, y: 0 }.'],
    ['an axis that is not a number', { y: Number.NaN }, 'scroll() takes x and y as finite numbers of CSS pixels, received { y: NaN }.'],
    ['an endless axis', { x: Number.NEGATIVE_INFINITY, y: 10 }, 'scroll() takes x and y as finite numbers of CSS pixels, received { x: -Infinity, y: 10 }.'],
    ['a distance as text', { y: '600' }, `${shape}, received { y: '600' }.`],
    ['a number on its own', 600, `${shape}, received 600.`],
    ['nothing', undefined, `${shape}, received undefined.`],
    ['null', null, `${shape}, received null.`],
    ['an axis set to null', { x: null, y: 600 }, `${shape}, received { x: null, y: 600 }.`],
    ['another key', { y: 600, behavior: 'smooth' }, `${shape}, received { y: 600, behavior: 'smooth' }.`],
    ['a list', [0, 600], `${shape}, received [ 0, 600 ].`],
  ]
  for (const [what, argument, message] of refusals) {
    for (const on of ['locator', 'page'] as const) {
      test(`${what} on the ${on} is refused at the call and never sent`, async () => {
        const { runPage, commands } = inProcessRun(file, page)
        const verdict = await runPage(({ page: handle }) => callLoosely(on === 'locator' ? handle.getByTestId('terms') : handle, 'scroll', [argument]))
        assert.deepEqual(commands, [])
        assert.equal(verdict.failure?.class, 'usage')
        assert.equal(verdict.failure?.message, message)
        assert.equal(verdict.failure?.location?.file, 'tests/support/api/call-loosely.ts', 'located at the call that made it')
      })
    }
  }
})

describe('select, check, uncheck and scroll follow every action rule', () => {
  // Each starts one of the new actions on the page: [how the test writes it, the call].
  const actions: [string, (handle: AppPage) => Promise<void>][] = [
    ["getByLabel('Country').select('Canada')", (handle) => handle.getByLabel('Country').select('Canada')],
    ["getByLabel('Remember me').check()", (handle) => handle.getByLabel('Remember me').check()],
    ["getByLabel('Remember me').uncheck()", (handle) => handle.getByLabel('Remember me').uncheck()],
    ["getByTestId('terms').scroll({ y: 600 })", (handle) => handle.getByTestId('terms').scroll({ y: 600 })],
    ['page.scroll({ x: -40 })', (handle) => handle.scroll({ x: -40 })],
  ]
  const escaped = (label: string): string => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  for (const [label, act] of actions) {
    test(`${label}: the parent's refusal fails the test at the call, which is sent once`, async () => {
      const lost: Responder = (command) =>
        command.kind === 'observe' ? page(command, '') : { ok: false, failure: { class: 'outcome_unknown', message: 'The browser closed during the action.' } }
      const { runPage, commands } = inProcessRun(file, lost)
      const verdict = await runPage(({ page: handle }) => act(handle))
      assert.equal(verdict.failure?.class, 'outcome_unknown')
      assert.equal(verdict.failure?.location?.file, file)
      assert.equal(commands.length, 1, 'an action is never sent again')
    })

    test(`${label}: while another command runs on its app it fails at once and names both`, async () => {
      const slow: Responder = (command) => new Promise((resolve) => setTimeout(() => resolve(page(command, '') ?? { ok: true, kind: 'click' }), 30))
      const { runPage, commands } = inProcessRun(file, slow)
      const verdict = await runPage(async ({ page: handle }) => {
        await Promise.all([handle.getByTestId('save-task').click(), act(handle)])
      })
      assert.equal(verdict.failure?.class, 'concurrent_commands')
      assert.match(verdict.failure?.message ?? '', new RegExp(`was still running when line \\d+ \\(${escaped(label)}\\) sent the next command to page\\.`))
      assert.equal(commands.length, 1)
    })

    test(`${label}: still running when the test returns, it fails the test`, async () => {
      const { runPage } = inProcessRun(file, () => undefined)
      const verdict = await runPage(({ page: handle }) => {
        act(handle).catch(() => undefined)
        expect(1).toBe(1)
      })
      assert.equal(verdict.failure?.class, 'not_awaited')
      assert.match(verdict.failure?.message ?? '', new RegExp(`^${escaped(label)} on line \\d+ was still running when the test returned\\.`))
    })

    test(`${label}: inside the function expect.poll calls it is refused, since it would run on every look`, async () => {
      const { runPage, commands } = inProcessRun(file, page)
      const verdict = await runPage(({ page: handle }) => expect.poll(() => act(handle).then(() => 1)).toBe(1))
      assert.deepEqual(commands, [])
      assert.equal(verdict.failure?.class, 'usage')
      assert.match(verdict.failure?.message ?? '', new RegExp(`${escaped(label)} on line \\d+ would run again each time\\.$`))
    })
  }
})
