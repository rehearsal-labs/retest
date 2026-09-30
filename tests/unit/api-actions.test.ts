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
      'press() takes a named key (Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp or PageDown), Shift+ and a named key, such as Shift+Tab, or one character, such as a, 7 or é, received "Entr".',
    ],
    [
      'a Control shortcut',
      'Control+a',
      'unsupported',
      `press() does not send Control, Alt or Meta, received "Control+a". An editing shortcut needs the platform's own command, and the platforms differ.`,
    ],
    ['Shift with a character', 'Shift+a', 'usage', 'Shift+ goes only with a named key, received "Shift+a". For an uppercase letter, press the letter itself, such as A.'],
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
