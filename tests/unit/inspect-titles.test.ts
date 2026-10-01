import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fakeCli, writeRunFolder } from './cli-fixtures.ts'
import { actionsPassRun, checkIgnoredRun, preferencesProject, savesPreferences } from './reporters-action-fixtures.ts'
import { plain, resultOf } from './reporters-fixtures.ts'
import { checkoutProject, hostCheckFailureRun, hostCheckResult, placesOrder } from './reporters-host-check-fixtures.ts'

const root = preferencesProject()
mkdirSync(join(root, 'runs'))

function folder(name: string, events: RetestEvent[]): string {
  writeRunFolder(join(root, 'runs'), name, { events, result: resultOf(events) })
  return `runs/${name}`
}

async function inspect(args: string[], options: { cwd?: string; isTTY?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const fake = fakeCli({ cwd: options.cwd ?? root, ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }) })
  const code = await fake.cli(['inspect', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

// The lines of a timeline from its first event to the test's end, without the column of times.
function timeline(stdout: string): string[] {
  const lines = stdout.split('\n')
  const start = lines.findIndex((line) => line.endsWith('started'))
  const end = lines.findIndex((line, index) => index > start && line === '')
  return lines.slice(start, end).map((line) => line.replace(/^ {2}[ \d.ms]{9} {2}/, ''))
}

function navigations(events: RetestEvent[], change: (event: Extract<RetestEvent, { type: 'navigation' }>) => RetestEvent): RetestEvent[] {
  return events.map((event) => (event.type === 'navigation' ? change(event) : event))
}

describe('inspect a test that chose, ticked and scrolled', () => {
  test('each action reads as the test wrote it, with what it changed, and each navigation names its title and what started it', async () => {
    const { code, stdout, stderr } = await inspect([folder('pass', actionsPassRun(root)), '--test', savesPreferences])
    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.deepEqual(timeline(stdout), [
      'started',
      'web  goto → http://127.0.0.1:4173/preferences  40 ms',
      'web  navigated to "Preferences" at http://127.0.0.1:4173/preferences, by goto',
      "web  getByLabel('Country').select('Canada'), set by script  8 ms",
      "web  getByLabel('Toppings').select(['Cheese', { value: 'olives' }]), set by script  9 ms",
      "web  getByRole('checkbox', { name: 'Newsletter' }).check(), already checked, sent nothing  3 ms",
      "web  getByLabel('Remember me').check(), clicked its label  14 ms",
      "web  getByRole('switch', { name: 'Dark mode' }).uncheck()  11 ms",
      "web  getByTestId('terms').scroll({ y: 400 })  6 ms",
      'web  page.scroll({ y: 600 })  5 ms',
      "web  click getByRole('button', { name: 'Save' })  10 ms",
      'web  navigated to "Preferences saved" at http://127.0.0.1:4173/preferences/saved, by an action',
      "✓ toHaveText getByRole('status')  30 ms",
      '  looked 1 time, passed on o1: 1 match, text "Saved"',
      'web  navigated to http://127.0.0.1:4173/home, by the page',
      'passed  900 ms',
    ])
  })

  test('an uncheck or select that found nothing to change says so, and a tap on a touch screen says it tapped', async () => {
    const events = actionsPassRun(root).map((event): RetestEvent => {
      if (event.type !== 'action.completed') return event
      if (event.command === 'uncheck') return { ...event, changed: false }
      if (event.command === 'select' && event.locator?.by === 'label' && event.locator.text === 'Country') return { ...event, changed: false }
      if (event.command === 'check' && event.via === 'label') return { ...event, touch: true }
      return event
    })
    const lines = timeline((await inspect([folder('unchanged', events), '--test', savesPreferences])).stdout)
    assert.deepEqual(
      lines.filter((line) => /already|tapped/.test(line)),
      [
        "web  getByLabel('Country').select('Canada'), already selected, sent nothing  8 ms",
        "web  getByRole('checkbox', { name: 'Newsletter' }).check(), already checked, sent nothing  3 ms",
        "web  getByLabel('Remember me').check(), tapped its label  14 ms",
        "web  getByRole('switch', { name: 'Dark mode' }).uncheck(), already unchecked, sent nothing  11 ms",
      ],
    )
  })

  test('a failed check is marked in the timeline, then the card shows the page by its title', async () => {
    const { stdout } = await inspect([folder('ignored', checkIgnoredRun(root)), '--test', savesPreferences])
    assert.ok(timeline(stdout).includes("web  ✗ getByLabel('Remember me').check(), clicked its label  5s  not_actionable"), stdout)
    assert.match(stdout, /\n {4}Page {13}"Preferences" at http:\/\/127\.0\.0\.1:4173\/preferences\n/)
  })
})

describe('titles and causes a run did not record', () => {
  test('a navigation shows only the title and cause it recorded, and a run from before them its address alone', async () => {
    const older = navigations(actionsPassRun(root), (event) => {
      const { title, cause, ...recorded } = event
      return recorded
    })
    const olderLines = timeline((await inspect([folder('older', older), '--test', savesPreferences])).stdout)
    assert.deepEqual(
      olderLines.filter((line) => line.includes('navigated')),
      [
        'web  navigated to http://127.0.0.1:4173/preferences',
        'web  navigated to http://127.0.0.1:4173/preferences/saved',
        'web  navigated to http://127.0.0.1:4173/home',
      ],
    )
    const events = navigations(actionsPassRun(root), (event) => {
      if (event.cause === 'goto') {
        const { cause, ...titled } = event
        return titled
      }
      const { title, ...caused } = event
      return caused
    })
    const lines = timeline((await inspect([folder('partial', events), '--test', savesPreferences])).stdout)
    assert.deepEqual(
      lines.filter((line) => line.includes('navigated')),
      [
        'web  navigated to "Preferences" at http://127.0.0.1:4173/preferences',
        'web  navigated to http://127.0.0.1:4173/preferences/saved, by an action',
        'web  navigated to http://127.0.0.1:4173/home, by the page',
      ],
    )
  })
})

describe('page text in a timeline', () => {
  test('a title and an address with control characters in them are written as escapes', async () => {
    const events = navigations(actionsPassRun(root), (event) =>
      event.cause === 'goto' ? { ...event, url: `${event.url}\u009b`, title: 'Pre\u001b[2Jfs\u0085' } : event,
    )
    const { stdout } = await inspect([folder('control', events), '--test', savesPreferences], { isTTY: true })
    assert.ok(plain(stdout).includes(String.raw`navigated to "Pre\u001b[2Jfs\u0085" at http://127.0.0.1:4173/preferences\u009b, by goto`), stdout)
    assert.doesNotMatch(plain(stdout), /[\u0085\u009b]|\u001b\[2J/)
  })

  test("a failed host check's page names the title it saw", async () => {
    const checkout = checkoutProject()
    mkdirSync(join(checkout, 'runs'))
    const events = hostCheckFailureRun(checkout).map((event) =>
      event.type === 'host_check.failed' && event.check.kind === 'text' ? { ...event, actual: { ...event.actual, title: 'Your cart' } } : event,
    )
    writeRunFolder(join(checkout, 'runs'), 'titled', { events, result: hostCheckResult(events) })
    const { stdout } = await inspect(['runs/titled', '--test', placesOrder], { cwd: checkout })
    assert.ok(timeline(stdout).includes('       page "Your cart" at http://127.0.0.1:4173/cart, text not found'), stdout)
    assert.ok(timeline(stdout).includes('       page http://127.0.0.1:4173/cart'), stdout)
  })
})
