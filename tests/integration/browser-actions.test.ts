import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { TaskApp, TaskAppOptions } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import {
  assertOk,
  byLabel,
  byRole,
  check,
  click,
  failureOf,
  fill,
  goto,
  launchGated,
  observe,
  observeUntil,
  openApp,
  openPage,
  press,
  scroll,
  select,
  servePages,
  sharedBrowser,
  timed,
  uncheck,
} from './browser-harness.ts'
import { observationOf } from '../support/observation.ts'

const browser = sharedBrowser()

async function taskPage(t: TestContext, options?: TaskAppOptions) {
  const app = await openApp(t, options)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/'))
  return { app, page }
}

async function customPage(t: TestContext, body: string) {
  const site = await servePages(t, { '/': `<!doctype html><meta charset="utf-8"><body>${body}</body>` })
  const page = await openPage(t, browser(), site.url)
  assertOk(await goto(page, '/'))
  return { site, page }
}

// The page's save handler shows "Saving…" before it sends anything, so an empty result means it never ran,
// and no request can still be on its way to the counter.
async function assertNothingSaved(page: OwnedPage, app: TaskApp): Promise<void> {
  assert.equal((await observe(page, 'saved-task')).text, '')
  assert.equal(app.submissions(), 0)
}

// Shows a field's value in a testid-addressed element, since observe reads text, not values.
const mirror = (field: string) => `<pre data-testid="mirror"></pre><script>
  const field = document.querySelector('[data-testid="${field}"]')
  const mirror = document.querySelector('[data-testid="mirror"]')
  mirror.textContent = field.value
  field.addEventListener('input', () => { mirror.textContent = field.value })
</script>`

test('fills the title, clicks save once and reads the saved title back', async (t) => {
  const { app, page } = await taskPage(t)
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  assertOk(await click(page, 'save-task'))
  const saved = await observeUntil(page, 'saved-task', (seen) => seen.text === 'Release checklist')
  assert.deepEqual(saved, observationOf([{ text: 'Release checklist', visible: true }]))
  assert.equal(app.submissions(), 1)
})

test('the broken app shows the wrong title after the same actions', async (t) => {
  const { app, page } = await taskPage(t, { mode: 'broken' })
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  assertOk(await click(page, 'save-task'))
  const saved = await observeUntil(page, 'saved-task', (seen) => seen.text !== '' && seen.text !== 'Saving…')
  assert.equal(saved.text, 'Release checklis')
  assert.equal(app.submissions(), 1)
})

test('two elements with the test id fail as ambiguous at once, and neither is clicked', async (t) => {
  const { app, page } = await taskPage(t, { mode: 'duplicate' })
  const { value: result, ms } = await timed(click(page, 'save-task', 5000))
  const failure = failureOf(result)
  assert.equal(failure.class, 'ambiguous')
  assert.deepEqual(failure.details, { count: 2 })
  assert.match(failure.message, /getByTestId\('save-task'\): it matches 2 elements/)
  assert.ok(ms < 1000, `ambiguity should fail at once, took ${ms} ms`)
  await assertNothingSaved(page, app)
})

test('an overlay stops the click, names what covers the button, and nothing is submitted', async (t) => {
  const { app, page } = await taskPage(t, { mode: 'overlay' })
  const failure = failureOf(await click(page, 'save-task', 500))
  assert.equal(failure.class, 'not_actionable')
  assert.deepEqual(failure.details, { check: 'hit-target', covering: '<div>', waitedMs: 500 })
  assert.equal(failure.message, "Could not click getByTestId('save-task') within 500 ms: another element, <div>, covers its centre.")
  await assertNothingSaved(page, app)
})

test('a cover that appears when the button is pressed takes the release, and Retest stops it before the page hears it', async (t) => {
  const { app, page } = await taskPage(t, { mode: 'covered-on-press' })
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  const failure = failureOf(await click(page, 'save-task'))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(
    failure.message,
    `Could not click getByTestId('save-task'): it took the press, but another element, <div data-testid="cover">, took the release. Retest stopped the release and the click before the page received them.`,
  )
  assert.deepEqual(failure.details, { check: 'hit-target', interceptedBy: '<div data-testid="cover">', event: 'pointerup' })
  await assertNothingSaved(page, app)
})

test('a cover that appears when the pointer arrives takes the press, and the page never hears the click', async (t) => {
  const { app, page } = await taskPage(t, { mode: 'covered-on-hover' })
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  const failure = failureOf(await click(page, 'save-task'))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(
    failure.message,
    `Could not click getByTestId('save-task'): another element, <div data-testid="cover">, was on top of it when Retest pressed. Retest stopped the click before the page received it.`,
  )
  assert.deepEqual(failure.details, { check: 'hit-target', interceptedBy: '<div data-testid="cover">', event: 'pointerdown' })
  // The page saves on any click on the cover, from a listener on the window it added before Retest acted.
  await assertNothingSaved(page, app)
})

test('a frame that covers the button when the pointer arrives takes the click, and the outcome is unknown', async (t) => {
  const { page } = await customPage(
    t,
    `<button data-testid="button" style="width: 200px; height: 60px">Press</button><p data-testid="status">none</p>
    <iframe data-testid="frame" style="position: fixed; inset: 0; width: 100%; height: 100%; border: 0; visibility: hidden"
      srcdoc="<script>addEventListener('click', () => { parent.document.querySelector('[data-testid=status]').textContent = 'frame clicked' })</script>"></iframe>
    <script>
      document.querySelector('[data-testid="button"]').addEventListener('pointerover', () => {
        document.querySelector('[data-testid="frame"]').style.visibility = 'visible'
      }, { once: true })
    </script>`,
  )
  const failure = failureOf(await click(page, 'button'))
  assert.equal(failure.class, 'outcome_unknown')
  assert.equal(
    failure.message,
    `Retest pressed at the centre of getByTestId('button'), but the press never reached the element's document, and <iframe data-testid="frame"> is at that point. Retest cannot tell what received the click.`,
  )
  assert.equal((await observe(page, 'status')).text, 'frame clicked')
})

test('a click on a label reaches the label, and the click it passes on reaches its field', async (t) => {
  const { page } = await customPage(
    t,
    `<label data-testid="agree" for="box">I agree</label><input id="box" type="checkbox"><p data-testid="state">false</p>
    <script>
      const box = document.getElementById('box')
      box.addEventListener('change', () => { document.querySelector('[data-testid="state"]').textContent = String(box.checked) })
    </script>`,
  )
  assertOk(await click(page, 'agree'))
  await observeUntil(page, 'state', (seen) => seen.text === 'true')
})

test('an overlay also stops fill from reaching the field', async (t) => {
  const { page } = await taskPage(t, { mode: 'overlay' })
  const failure = failureOf(await fill(page, 'task-title', 'Release checklist', 500))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.details?.['check'], 'hit-target')
})

test('a disabled field is not filled and keeps its value', async (t) => {
  const { page } = await taskPage(t, { mode: 'disabled' })
  const failure = failureOf(await fill(page, 'task-title', 'Release checklist', 500))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.message, "Could not fill getByTestId('task-title') within 500 ms: it is disabled.")
  assertOk(await click(page, 'save-task'))
  await observeUntil(page, 'saved-task', (seen) => seen.text === 'Existing task')
})

test('a read-only field is not filled and keeps its value', async (t) => {
  const { page } = await taskPage(t, { mode: 'readonly' })
  const failure = failureOf(await fill(page, 'task-title', 'Release checklist', 500))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.details?.['check'], 'editable')
  assertOk(await click(page, 'save-task'))
  await observeUntil(page, 'saved-task', (seen) => seen.text === 'Existing task')
})

test('a save button replaced after load is found again and the new one saves', async (t) => {
  const { app, page } = await taskPage(t, { mode: 'replaced' })
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  await observeUntil(page, 'save-replaced', (seen) => seen.count === 1)
  assertOk(await click(page, 'save-task'))
  await observeUntil(page, 'saved-task', (seen) => seen.text === 'Release checklist')
  assert.equal(app.submissions(), 1)
})

test('a locator resolves the element that is there now, never one it saw before', async (t) => {
  const { page } = await customPage(
    t,
    `<button data-testid="target">Old</button><button data-testid="swap">Swap</button><p data-testid="status">none</p>
    <script>
      const status = document.querySelector('[data-testid="status"]')
      document.querySelector('[data-testid="target"]').addEventListener('click', () => { status.textContent = 'old clicked' })
      document.querySelector('[data-testid="swap"]').addEventListener('click', () => {
        const next = document.createElement('button')
        next.dataset.testid = 'target'
        next.textContent = 'New'
        next.addEventListener('click', () => { status.textContent = 'new clicked' })
        document.querySelector('[data-testid="target"]').replaceWith(next)
        status.textContent = 'swapped'
      })
    </script>`,
  )
  assert.equal((await observe(page, 'target')).text, 'Old')
  assertOk(await click(page, 'swap'))
  await observeUntil(page, 'status', (seen) => seen.text === 'swapped')
  assertOk(await click(page, 'target'))
  await observeUntil(page, 'status', (seen) => seen.text === 'new clicked')
  assert.equal((await observe(page, 'target')).text, 'New')
})

test('a slow save is waited for by looking again, and is submitted once', async (t) => {
  const { app, page } = await taskPage(t, { mode: 'delayed', delayMs: 800 })
  assertOk(await fill(page, 'task-title', 'Release checklist'))
  assertOk(await click(page, 'save-task'))
  const seen = new Set<string | null>()
  await observeUntil(page, 'saved-task', (observation) => {
    seen.add(observation.text)
    return observation.text === 'Release checklist'
  })
  assert.ok(seen.has('Saving…'), 'the page should have shown its pending state while Retest looked')
  assert.equal(app.submissions(), 1)
})

test('an element that never appears fails as not found when the time runs out', async (t) => {
  const { page } = await taskPage(t)
  const { value: result, ms } = await timed(click(page, 'missing', 500))
  const failure = failureOf(result)
  assert.equal(failure.class, 'not_found')
  assert.equal(failure.message, "Could not click getByTestId('missing'): no element matched within 500 ms.")
  assert.ok(ms >= 490 && ms < 1500, `took ${ms} ms`)
})

test('an element that appears while the action waits is used', async (t) => {
  const { page } = await customPage(
    t,
    `<p data-testid="status">none</p><script>
      setTimeout(() => {
        const button = document.createElement('button')
        button.dataset.testid = 'late'
        button.textContent = 'Late'
        button.addEventListener('click', () => { document.querySelector('[data-testid="status"]').textContent = 'clicked' })
        document.body.append(button)
      }, 300)
    </script>`,
  )
  assertOk(await click(page, 'late', 3000))
  await observeUntil(page, 'status', (seen) => seen.text === 'clicked')
})

test('fill replaces the whole current value', async (t) => {
  const { page } = await customPage(t, `<input data-testid="field" value="Existing">${mirror('field')}`)
  assert.equal((await observe(page, 'mirror')).text, 'Existing')
  assertOk(await fill(page, 'field', 'Release checklist'))
  assert.equal((await observe(page, 'mirror')).text, 'Release checklist')
  assertOk(await fill(page, 'field', 'Second'))
  assert.equal((await observe(page, 'mirror')).text, 'Second')
})

test('fill with an empty value clears the field', async (t) => {
  const { page } = await customPage(t, `<input data-testid="field" value="Existing">${mirror('field')}`)
  assertOk(await fill(page, 'field', ''))
  assert.equal((await observe(page, 'mirror')).text, '')
})

test('fill types line breaks into a textarea', async (t) => {
  const { page } = await customPage(t, `<textarea data-testid="notes">Old</textarea>${mirror('notes')}`)
  assertOk(await fill(page, 'notes', 'line one\nline two'))
  assert.equal((await observe(page, 'mirror')).text, 'line one\nline two')
})

test('fill replaces the value of every supported input type', async (t) => {
  const types = ['text', 'search', 'email', 'url', 'tel', 'password', 'number']
  const fields = types.map((type) => `<input type="${type}" data-testid="${type}" value="${type === 'number' ? 7 : 'old@example.test'}">`)
  const { page } = await customPage(
    t,
    `${fields.join('')}<input data-testid="untyped" value="old"><pre data-testid="values"></pre><script>
      addEventListener('input', () => {
        document.querySelector('[data-testid="values"]').textContent =
          [...document.querySelectorAll('input')].map((input) => input.value).join('|')
      })
    </script>`,
  )
  for (const type of [...types, 'untyped']) assertOk(await fill(page, type, type === 'number' ? '42' : `${type}@example.test`))
  assert.equal(
    (await observe(page, 'values')).text,
    'text@example.test|search@example.test|email@example.test|url@example.test|tel@example.test|password@example.test|42|untyped@example.test',
  )
})

// Moves the keyboard focus once Retest has focused and checked the field, and before its text arrives.
const STEAL_FOCUS = `<input data-testid="field" value="Old"><input data-testid="other" value="Other"><pre data-testid="values"></pre>
<script>
  const values = document.querySelector('[data-testid="values"]')
  const show = () => { values.textContent = [...document.querySelectorAll('input')].map((input) => input.value).join('|') }
  show()
  addEventListener('input', show)
  document.querySelector('[data-testid="field"]').addEventListener('focus', () => {
    queueMicrotask(() => document.querySelector('[data-testid="other"]').focus())
  })
</script>`

test('fill stops the typing when the focus moves after Retest focused the field, and names where it went', async (t) => {
  const { page } = await customPage(t, STEAL_FOCUS)
  for (const [value, event] of [['Release checklist', 'beforeinput'], ['', 'keydown']] as const) {
    const failure = failureOf(await fill(page, 'field', value))
    assert.equal(failure.class, 'not_actionable')
    assert.equal(
      failure.message,
      `Could not fill getByTestId('field'): the keyboard focus moved to another element, <input data-testid="other">, before Retest typed. Retest stopped the typing before the page received it.`,
    )
    assert.deepEqual(failure.details, { check: 'focused', focus: '<input data-testid="other">', event })
    assert.equal((await observe(page, 'values')).text, 'Old|Other')
  }
})

test('fill replaces the whole value even when the page moves the caret after Retest selected it', async (t) => {
  const { page } = await customPage(
    t,
    `<input data-testid="field" value="Existing"><button data-testid="elsewhere">Elsewhere</button>${mirror('field')}<script>
      const moved = document.querySelector('[data-testid="field"]')
      moved.addEventListener('focus', () => queueMicrotask(() => moved.setSelectionRange(moved.value.length, moved.value.length)))
    </script>`,
  )
  assertOk(await fill(page, 'field', 'New'))
  assert.equal((await observe(page, 'mirror')).text, 'New')
  assertOk(await click(page, 'elsewhere'))
  assertOk(await fill(page, 'field', ''))
  assert.equal((await observe(page, 'mirror')).text, '')
})

test('fill refuses a checkbox at once and leaves it unchanged', async (t) => {
  const { page } = await customPage(
    t,
    `<input type="checkbox" data-testid="agree"><p data-testid="state"></p><script>
      const box = document.querySelector('[data-testid="agree"]')
      const state = document.querySelector('[data-testid="state"]')
      state.textContent = String(box.checked)
      box.addEventListener('change', () => { state.textContent = String(box.checked) })
    </script>`,
  )
  const { value: result, ms } = await timed(fill(page, 'agree', 'yes', 5000))
  const failure = failureOf(result)
  assert.equal(failure.class, 'unsupported')
  assert.equal(
    failure.message,
    `Could not fill getByTestId('agree'): it is <input type="checkbox">, and fill supports a textarea, or an input of type text, search, email, url, tel, password or number.`,
  )
  assert.ok(ms < 1000, `an unsupported field should fail at once, took ${ms} ms`)
  assert.equal((await observe(page, 'state')).text, 'false')
})

test('fill refuses an element that is not a field', async (t) => {
  const { page } = await customPage(t, `<div data-testid="box" contenteditable>Text</div>`)
  const failure = failureOf(await fill(page, 'box', 'New'))
  assert.equal(failure.class, 'unsupported')
  assert.deepEqual(failure.details, { field: '<div>' })
  assert.equal((await observe(page, 'box')).text, 'Text')
})

test('fill refuses a line break for an input at once and leaves the input unchanged', async (t) => {
  const { page } = await taskPage(t)
  assertOk(await fill(page, 'task-title', 'Before'))
  for (const value of ['one\ntwo', 'one\rtwo']) {
    const { value: result, ms } = await timed(fill(page, 'task-title', value, 5000))
    const failure = failureOf(result)
    assert.equal(failure.class, 'unsupported')
    assert.match(failure.message, /with a line break: it is <input type="text">, which holds one line/)
    assert.ok(ms < 1000, `took ${ms} ms`)
  }
  assertOk(await click(page, 'save-task'))
  await observeUntil(page, 'saved-task', (seen) => seen.text === 'Before')
})

test('a hidden element is not clicked, and the failure names visibility', async (t) => {
  const { page } = await customPage(t, `<button data-testid="hidden" style="visibility: hidden">Hidden</button>`)
  const failure = failureOf(await click(page, 'hidden', 300))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.details?.['check'], 'visible')
})

test('a disabled button is not clicked, and the failure names it', async (t) => {
  const { page } = await customPage(t, `<fieldset disabled><button data-testid="inside">Save</button></fieldset>`)
  const failure = failureOf(await click(page, 'inside', 300))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.details?.['check'], 'enabled')
})

test('an element that keeps moving is not clicked', async (t) => {
  const { page } = await customPage(
    t,
    `<style>@keyframes slide { from { margin-left: 0 } to { margin-left: 300px } }</style>
    <button data-testid="moving" style="animation: slide 400ms linear infinite alternate">Moving</button>
    <p data-testid="status">none</p>
    <script>document.querySelector('[data-testid="moving"]').addEventListener('click', () => {
      document.querySelector('[data-testid="status"]').textContent = 'clicked'
    })</script>`,
  )
  const failure = failureOf(await click(page, 'moving', 500))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.details?.['check'], 'stable')
  assert.equal((await observe(page, 'status')).text, 'none')
})

test('an element below the fold is scrolled into view and clicked', async (t) => {
  const { page } = await customPage(
    t,
    `<div style="height: 3000px"></div><button data-testid="far">Far</button><p data-testid="status">none</p>
    <script>document.querySelector('[data-testid="far"]').addEventListener('click', () => {
      document.querySelector('[data-testid="status"]').textContent = 'clicked ' + Math.round(scrollY > 0)
    })</script>`,
  )
  assertOk(await click(page, 'far'))
  await observeUntil(page, 'status', (seen) => seen.text === 'clicked 1')
})

test('a click at the centre may land on a child of the element', async (t) => {
  const { page } = await customPage(
    t,
    `<button data-testid="parent"><span style="display: inline-block; padding: 20px">Label</span></button>
    <p data-testid="status">none</p>
    <script>document.querySelector('[data-testid="parent"]').addEventListener('click', (event) => {
      document.querySelector('[data-testid="status"]').textContent = event.target.localName
    })</script>`,
  )
  assertOk(await click(page, 'parent'))
  await observeUntil(page, 'status', (seen) => seen.text === 'span')
})

test('a click is a real press and release that page scripts see as trusted', async (t) => {
  const { page } = await customPage(
    t,
    `<button data-testid="button">Press</button><p data-testid="events"></p><script>
      const events = []
      for (const type of ['mousedown', 'mouseup', 'click']) {
        document.querySelector('[data-testid="button"]').addEventListener(type, (event) => {
          events.push(type + ':' + event.isTrusted)
          document.querySelector('[data-testid="events"]').textContent = events.join(' ')
        })
      }
    </script>`,
  )
  assertOk(await click(page, 'button'))
  await observeUntil(page, 'events', (seen) => seen.text === 'mousedown:true mouseup:true click:true')
})

test('observe counts matches and reads visibility and text only for exactly one', async (t) => {
  const { page } = await taskPage(t, { mode: 'duplicate' })
  const save = { text: 'Save', visible: true }
  assert.deepEqual(await observe(page, 'save-task'), observationOf([save, save]))
  assert.deepEqual(await observe(page, 'missing'), observationOf([]))
  assert.deepEqual(await observe(page, 'task-title'), observationOf([{ text: '', visible: true }], ''))
})

test('observe reads elements hidden in each way as not visible', async (t) => {
  const { page } = await customPage(
    t,
    `<p data-testid="none" style="display: none">a</p>
    <p data-testid="hidden" style="visibility: hidden">b</p>
    <div style="display: none"><p data-testid="inside">c</p></div>
    <p data-testid="empty"></p>
    <p data-testid="shown">d</p>`,
  )
  for (const testId of ['none', 'hidden', 'inside', 'empty']) {
    assert.equal((await observe(page, testId)).visible, false, testId)
  }
  assert.deepEqual(await observe(page, 'shown'), observationOf([{ text: 'd', visible: true }]))
})

test('a test id matches exactly, and its value is never read as code or a selector', async (t) => {
  const tricky = `a"b'c\\] , * ); throw 1; //`
  const { page } = await customPage(
    t,
    `<p data-testid="save">exact</p><p data-testid="save-task">longer</p><p data-testid="Save">case</p>
    <p id="tricky">tricky</p><script>document.getElementById('tricky').dataset.testid = ${JSON.stringify(tricky)}</script>`,
  )
  assert.deepEqual(await observe(page, 'save'), observationOf([{ text: 'exact', visible: true }]))
  assert.deepEqual(await observe(page, tricky), observationOf([{ text: 'tricky', visible: true }]))
  for (const value of ['sav', '*', '', 'save ', 'SAVE']) assert.equal((await observe(page, value)).count, 0, value)
})

test('page scripts cannot replace the functions Retest uses to find and check elements', async (t) => {
  const { page } = await customPage(
    t,
    `<button data-testid="button">Press</button><p data-testid="status">none</p><script>
      document.querySelectorAll = () => []
      Element.prototype.getAttribute = () => 'button'
      Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 })
      document.elementFromPoint = () => null
      document.querySelector('[data-testid="button"]').addEventListener('click', () => {
        document.querySelector('[data-testid="status"]').textContent = 'clicked'
      })
    </script>`,
  )
  assert.equal((await observe(page, 'button')).count, 1)
  assertOk(await click(page, 'button'))
  await observeUntil(page, 'status', (seen) => seen.text === 'clicked')
})

test('a click that opens an alert fails at once as unsupported, and later commands fail at once while it is open', async (t) => {
  const { page } = await customPage(
    t,
    `<button data-testid="warn">Warn</button><script>
      document.querySelector('[data-testid="warn"]').addEventListener('click', () => alert('Careful'))
    </script>`,
  )
  const { value: result, ms: clickMs } = await timed(click(page, 'warn', 5000))
  assert.ok(clickMs < 1500, `the click waiting on the dialog should fail at once, took ${clickMs} ms of its 5000`)
  const clicked = failureOf(result)
  assert.deepEqual([clicked.class, clicked.details], ['unsupported', { dialog: 'alert', inputSent: true }])
  assert.equal(
    clicked.message,
    "The page opened an alert dialog while Retest tried to click getByTestId('warn'). Retest does not answer dialogs yet, and the dialog blocks the page.",
  )
  const { value, ms } = await timed(page.execute({ kind: 'observe', locator: { by: 'testId', value: 'warn' } }, 1000))
  assert.deepEqual(failureOf(value).details, { dialog: 'alert', inputSent: false })
  assert.ok(ms < 500, `a blocked page should fail at once, took ${ms} ms`)
  await assert.rejects(page.screenshot(1000), (error) => error instanceof BrowserError && error.failure.class === 'unsupported')
})

async function actionsPage(t: TestContext) {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  const visited: string[] = []
  page.onNavigation((navigation) => void visited.push(navigation.url))
  assertOk(await goto(page, '/actions'))
  return { app, page, visited }
}

test('Enter in a form field submits the form once, and the page that answers is followed as a navigation', async (t) => {
  const { app, page, visited } = await actionsPage(t)
  assertOk(await fill(page, 'query', 'release notes'))
  assert.deepEqual(await press(page, 'query', 'Enter'), { ok: true, kind: 'press', page: { url: `${app.url}/actions`, title: 'Actions' } })
  await observeUntil(page, 'submitted', (seen) => seen.text === 'Searched for release notes')
  assert.equal(app.searches(), 1)
  assert.deepEqual(visited, [`${app.url}/actions`, `${app.url}/actions/submit`])
})

test("Enter on the page's keyboard goes to the field a fill left the focus in, and submits its form once", async (t) => {
  const { app, page, visited } = await actionsPage(t)
  assertOk(await fill(page, 'query', 'keyboard'))
  assert.deepEqual(await press(page, undefined, 'Enter'), { ok: true, kind: 'press', page: { url: `${app.url}/actions`, title: 'Actions' } })
  await observeUntil(page, 'submitted', (seen) => seen.text === 'Searched for keyboard')
  assert.equal(app.searches(), 1)
  assert.equal(visited.at(-1), `${app.url}/actions/submit`)
})

test('Tab moves the focus to the next field, and Shift+Tab moves it back, each heard once', async (t) => {
  const { page } = await actionsPage(t)
  assertOk(await press(page, 'first', 'Tab'))
  await observeUntil(page, 'focus', (seen) => seen.text === 'second')
  assertOk(await press(page, undefined, 'Shift+Tab'))
  await observeUntil(page, 'focus', (seen) => seen.text === 'first')
  assert.equal((await observe(page, 'keys-heard')).text, 'Tab Tab:shift')
})

test('Space on a button presses it once', async (t) => {
  const { app, page } = await actionsPage(t)
  assertOk(await press(page, 'count', 'Space'))
  await observeUntil(page, 'clicks-answered', (seen) => seen.text === '1')
  assert.equal(app.clicks(), 1)
})

test('a character is typed with the key a person presses for it, and Shift for an uppercase letter or a shifted symbol', async (t) => {
  const { page } = await customPage(
    t,
    `<input data-testid="field"><pre data-testid="mirror"></pre><p data-testid="keys"></p><script>
      const field = document.querySelector('[data-testid="field"]')
      const keys = []
      field.addEventListener('input', () => { document.querySelector('[data-testid="mirror"]').textContent = field.value })
      field.addEventListener('keydown', (event) => {
        keys.push([event.key, event.code, event.shiftKey ? 'shift' : ''].join(':'))
        document.querySelector('[data-testid="keys"]').textContent = keys.join(' ')
      })
    </script>`,
  )
  for (const key of ['a', 'A', '7', '!', 'é']) assertOk(await press(page, 'field', key))
  assert.equal((await observe(page, 'mirror')).text, 'aA7!é')
  assert.equal((await observe(page, 'keys')).text, 'a:KeyA: A:KeyA:shift 7:Digit7: !:Digit1:shift é::')
})

test('each editing key edits a field once', async (t) => {
  const { page } = await customPage(t, `<input data-testid="field">${mirror('field')}`)
  const cases: [keys: string[], value: string][] = [
    [['Backspace'], 'abc'],
    [['ArrowLeft', 'Backspace'], 'abd'],
    [['ArrowLeft', 'ArrowLeft', 'Delete'], 'abd'],
    [['ArrowLeft', 'ArrowLeft', 'ArrowRight', 'X'], 'abcXd'],
    [['Shift+ArrowLeft', 'X'], 'abcX'],
    [['Home', 'X'], 'Xabcd'],
    [['Home', 'End', 'X'], 'abcdX'],
    [['Shift+Home', 'X'], 'X'],
  ]
  for (const [keys, value] of cases) {
    assertOk(await fill(page, 'field', 'abcd'))
    for (const key of keys) assertOk(await press(page, 'field', key))
    assert.equal((await observe(page, 'mirror')).text, value, keys.join(' then '))
  }
})

test('a key whose keydown the page cancels still reached its element, and the press passes', async (t) => {
  const { page, site } = await customPage(
    t,
    `<input data-testid="field">${mirror('field')}<script>
      document.querySelector('[data-testid="field"]').addEventListener('keydown', (event) => event.preventDefault())
    </script>`,
  )
  assert.deepEqual(await press(page, 'field', 'a'), { ok: true, kind: 'press', page: { url: `${site.url}/` } })
  assert.equal((await observe(page, 'mirror')).text, '')
})

test('a key the focus left for another element before it arrived is stopped before any listener of the page hears it', async (t) => {
  const { page } = await customPage(
    t,
    `<input data-testid="field"><div data-testid="dialog" tabindex="-1">Dialog</div><p data-testid="heard"></p><script>
      const heard = []
      for (const type of ['keydown', 'keypress', 'keyup']) {
        addEventListener(type, (event) => { heard.push(type); document.querySelector('[data-testid="heard"]').textContent = heard.join(' ') }, true)
      }
      document.querySelector('[data-testid="field"]').addEventListener('focus', () => {
        queueMicrotask(() => document.querySelector('[data-testid="dialog"]').focus())
      })
    </script>`,
  )
  assert.deepEqual(failureOf(await press(page, 'field', 'Enter')), {
    class: 'not_actionable',
    message: `Could not press Enter on getByTestId('field'): the keyboard focus moved to another element, <div data-testid="dialog">, before the key arrived. Retest stopped the key before the page received it.`,
    details: { check: 'focused', focus: '<div data-testid="dialog">', event: 'keydown' },
  })
  assert.equal((await observe(page, 'heard')).text, '', 'no listener of the page heard any part of the key')
})

test('a key is not pressed on an element that is hidden, disabled or cannot take the focus, and each failure says why', async (t) => {
  const { page } = await customPage(
    t,
    `<input data-testid="hidden" style="visibility: hidden"><input data-testid="disabled" disabled><div data-testid="plain">Text</div>`,
  )
  const cases = [
    ['hidden', 'visible', 'it is not visible'],
    ['disabled', 'enabled', 'it is disabled'],
    ['plain', 'focused', 'it did not keep the keyboard focus'],
  ] as const
  for (const [testId, check, reason] of cases) {
    assert.deepEqual(failureOf(await press(page, testId, 'Enter', 300)), {
      class: 'not_actionable',
      message: `Could not press Enter on getByTestId('${testId}') within 300 ms: ${reason}.`,
      details: { check, covering: null, waitedMs: 300 },
    })
  }
})

test("a key for the page's keyboard while the focus is inside a frame never reaches the page's document, so its outcome is unknown", async (t) => {
  const { page } = await customPage(
    t,
    `<iframe data-testid="frame" srcdoc="<input>"></iframe><p data-testid="status"></p><script>
      const frame = document.querySelector('[data-testid="frame"]')
      frame.addEventListener('load', () => {
        frame.contentDocument.querySelector('input').focus()
        document.querySelector('[data-testid="status"]').textContent = 'focused'
      })
    </script>`,
  )
  await observeUntil(page, 'status', (seen) => seen.text === 'focused')
  const result = await press(page, undefined, 'a')
  assert.deepEqual(failureOf(result), {
    class: 'outcome_unknown',
    message: `Retest pressed a, but the key never reached the page's document, and the keyboard focus is on <iframe data-testid="frame">. Retest cannot tell what received the key.`,
    details: { focus: '<iframe data-testid="frame">' },
  })
})

test("a key for the page's keyboard waits while the page opens another document, and fails naming it when that document never arrives", async (t) => {
  const never = await servePages(t, { '/': '<!doctype html><input autofocus>' }, { hold: () => new Promise(() => {}) })
  const { page } = await customPage(
    t,
    `<input data-testid="field" autofocus><p data-testid="heard"></p><script>
      addEventListener('keydown', () => { document.querySelector('[data-testid="heard"]').textContent = 'heard' }, true)
      addEventListener('load', () => { location.href = ${JSON.stringify(`${never.url}/`)} })
    </script>`,
  )
  assert.deepEqual(failureOf(await press(page, undefined, 'a', 1000)), {
    class: 'not_actionable',
    message: `Could not press a within 1000 ms: the page was still opening ${never.url}/, and Retest does not press in a document about to be replaced.`,
    details: { check: 'navigation', url: `${never.url}/`, waitedMs: 1000 },
  })
})

test('a browser lost between the key down and the key up leaves the outcome unknown, and the key went down once', async (t) => {
  const keyDowns: unknown[] = []
  const releaseHeld = Promise.withResolvers<void>()
  const browser = await launchGated(t, {
    hold: (method, params) => {
      if (method !== 'Input.dispatchKeyEvent') return undefined
      const type = typeof params === 'object' && params !== null && 'type' in params ? params.type : undefined
      if (type !== 'keyUp') {
        keyDowns.push(type)
        return undefined
      }
      releaseHeld.resolve()
      return new Promise(() => {})
    },
  })
  const app = await openApp(t)
  const page = await openPage(t, browser, app.url)
  assertOk(await goto(page, '/actions'))
  const pressing = press(page, 'query', 'Enter', 5000)
  await releaseHeld.promise
  signalGroup(browser.pid, 'SIGKILL')
  const failure = failureOf(await pressing)
  assert.equal(failure.class, 'outcome_unknown', JSON.stringify(failure))
  assert.match(failure.message, /^Retest lost the page after it began to press Enter on getByTestId\('query'\), so it cannot tell whether that took effect: /)
  assert.deepEqual(keyDowns, ['keyDown'])
})

async function choicesPage(t: TestContext) {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/actions/choices'))
  return { app, page, facts: { url: `${app.url}/actions/choices`, title: 'Choices' } }
}

test('select chooses an option by its label or its value, and the page hears input then change, as script', async (t) => {
  const { page, facts } = await choicesPage(t)
  assert.deepEqual(await select(page, 'country', 'Canada'), { ok: true, kind: 'select', changed: true, page: facts })
  assert.equal((await observe(page, 'country-shown')).text, 'ca')
  assert.deepEqual(await select(page, byLabel('Country'), { value: 'mx' }), { ok: true, kind: 'select', changed: true, page: facts })
  assert.equal((await observe(page, 'country-shown')).text, 'mx')
  assert.equal((await observe(page, 'changes-heard')).text, 'input:country:false change:country:false input:country:false change:country:false')
  // The option already chosen is left alone, and the page hears nothing.
  assert.deepEqual(await select(page, 'country', 'Mexico'), { ok: true, kind: 'select', changed: false, page: facts })
  assert.equal((await observe(page, 'changes-heard')).text, 'input:country:false change:country:false input:country:false change:country:false')
})

test('a list chooses exactly those options of a select multiple and clears the others; one option chooses just that one', async (t) => {
  const { page, facts } = await choicesPage(t)
  assert.equal((await observe(page, 'toppings-shown')).text, 'cheese')
  assert.deepEqual(await select(page, 'toppings', ['Basil', { value: 'olives' }]), { ok: true, kind: 'select', changed: true, page: facts })
  assert.equal((await observe(page, 'toppings-shown')).text, 'olives,basil')
  assert.deepEqual(await select(page, 'toppings', ['Olives', 'Basil']), { ok: true, kind: 'select', changed: false, page: facts })
  assertOk(await select(page, 'toppings', 'Garlic'))
  assert.equal((await observe(page, 'toppings-shown')).text, 'garlic')
})

test('an option that arrives late is waited for, and one that never does fails as not found, naming it', async (t) => {
  const { page } = await choicesPage(t)
  assertOk(await click(page, 'add-peru'))
  const { value: late, ms } = await timed(select(page, 'country', 'Peru', 3000))
  assertOk(late)
  assert.ok(ms >= 150, `the option arrived about 300 ms after the click, and the select waited ${ms} ms`)
  assert.equal((await observe(page, 'country-shown')).text, 'pe')
  const { value: missing, ms: waited } = await timed(select(page, 'country', 'Atlantis', 400))
  assert.deepEqual(failureOf(missing), {
    class: 'not_found',
    message: "Could not select 'Atlantis' in getByTestId('country'): no option matched 'Atlantis' within 400 ms.",
    details: { choice: "'Atlantis'", waitedMs: 400 },
  })
  assert.ok(waited >= 390, `waited ${waited} ms`)
  assert.equal((await observe(page, 'country-shown')).text, 'pe')
})

test('two options whose labels differ only in spacing fail as ambiguous at once, and nothing is chosen', async (t) => {
  const { page } = await choicesPage(t)
  const { value, ms } = await timed(select(page, 'city', 'Paris', 5000))
  assert.deepEqual(failureOf(value), {
    class: 'ambiguous',
    message: "Could not select 'Paris' in getByTestId('city'): 2 options match 'Paris', and each choice must match exactly one. Retest selected nothing.",
    details: { choice: "'Paris'", count: 2 },
  })
  assert.ok(ms < 1000, `ambiguity fails at once, took ${ms} ms`)
  assert.equal((await observe(page, 'city-shown')).text, 'paris-fr')
  assert.equal((await observe(page, 'changes-heard')).text, '')
})

test('a disabled option, on its own or in a disabled group, waits and fails as not actionable', async (t) => {
  const { page } = await choicesPage(t)
  for (const choice of ['France', 'Germany']) {
    assert.deepEqual(failureOf(await select(page, 'country', choice, 300)), {
      class: 'not_actionable',
      message: `Could not select '${choice}' in getByTestId('country') within 300 ms: the option '${choice}' is disabled.`,
      details: { check: 'enabled', choice: `'${choice}'`, waitedMs: 300 },
    })
  }
  assert.equal((await observe(page, 'country-shown')).text, 'none')
})

test('a list for a select that takes one option is usage, and an element that is not a select is unsupported, both at once', async (t) => {
  const { page } = await choicesPage(t)
  const { value: list, ms } = await timed(select(page, 'country', ['Canada'], 5000))
  assert.deepEqual(failureOf(list), {
    class: 'usage',
    message: `Could not select ['Canada'] in getByTestId('country'): it is <select id="country" data-testid="country">, which takes one option, and select() was given a list. Pass one option, not a list.`,
    details: { element: '<select id="country" data-testid="country">' },
  })
  assert.ok(ms < 1000, `took ${ms} ms`)
  const notSelect = failureOf(await select(page, 'agree', 'Canada', 5000))
  assert.equal(notSelect.class, 'unsupported')
  assert.equal(
    notSelect.message,
    `Could not select 'Canada' in getByTestId('agree'): it is <input data-testid="agree">, and select() chooses from a <select> element. Choose from a list the page draws itself with click().`,
  )
  assert.equal((await observe(page, 'country-shown')).text, 'none')
})

test('a click on a checkbox lets the input and change events the checkbox fires reach the page', async (t) => {
  const { page } = await choicesPage(t)
  assertOk(await click(page, 'agree'))
  await observeUntil(page, 'changes-heard', (seen) => seen.text === 'input:agree:true change:agree:true')
})

test('check clicks a native checkbox once; one already checked is left alone; uncheck clicks it once more', async (t) => {
  const { page, facts } = await choicesPage(t)
  assert.deepEqual(await check(page, byLabel('I agree')), { ok: true, kind: 'check', changed: true, page: facts })
  assert.deepEqual(await check(page, 'agree'), { ok: true, kind: 'check', changed: false, page: facts })
  assert.equal((await observe(page, 'clicks-heard')).text, 'agree=1', 'the second check sent nothing')
  assert.deepEqual(await uncheck(page, 'agree'), { ok: true, kind: 'uncheck', changed: true, page: facts })
  assert.equal((await observe(page, 'clicks-heard')).text, 'agree=2')
  assert.match((await observe(page, 'checks-shown')).text ?? '', /agree=false/)
})

test('check and uncheck work an element whose role is checkbox, by its aria-checked', async (t) => {
  const { page, facts } = await choicesPage(t)
  assert.deepEqual(await check(page, byRole('checkbox', 'Remember me')), { ok: true, kind: 'check', changed: true, page: facts })
  assert.match((await observe(page, 'checks-shown')).text ?? '', /remember=true/)
  assert.deepEqual(await uncheck(page, 'remember'), { ok: true, kind: 'uncheck', changed: true, page: facts })
  assert.match((await observe(page, 'checks-shown')).text ?? '', /remember=false/)
})

test('a hidden checkbox is checked through its styled label, which passes the click on to it', async (t) => {
  const { page, facts } = await choicesPage(t)
  assert.deepEqual(await check(page, byLabel('Newsletter')), { ok: true, kind: 'check', changed: true, via: 'label', page: facts })
  assert.match((await observe(page, 'checks-shown')).text ?? '', /newsletter=true/)
  assert.equal((await observe(page, 'clicks-heard')).text, 'newsletter-label=1 newsletter=1')
  assert.deepEqual(await uncheck(page, 'newsletter'), { ok: true, kind: 'uncheck', changed: true, via: 'label', page: facts })
  assert.match((await observe(page, 'checks-shown')).text ?? '', /newsletter=false/)
})

test('a control that takes its click and stays as it was fails after one click, and is not clicked again', async (t) => {
  const { app, page } = await choicesPage(t)
  const { value, ms } = await timed(check(page, 'locked', 500))
  assert.deepEqual(failureOf(value), {
    class: 'not_actionable',
    message: "Could not check getByTestId('locked'): Retest clicked it once, and it stayed unchecked. Retest does not click again.",
    details: { check: 'state', inputSent: true },
  })
  assert.ok(ms >= 450, `the state was read until the time ran out, ${ms} ms`)
  await observeUntil(page, 'clicks-heard', (seen) => seen.text === 'locked=1')
  const end = performance.now() + 2000
  while (app.toggles() < 1 && performance.now() < end) await delay(10)
  assert.equal(app.toggles(), 1, 'the server heard one click')
})

test('uncheck refuses a radio button at once, and check on another radio button unchecks the first', async (t) => {
  const { page, facts } = await choicesPage(t)
  const { value, ms } = await timed(uncheck(page, 'small', 5000))
  assert.deepEqual(failureOf(value), {
    class: 'unsupported',
    message: `Could not uncheck getByTestId('small'): it is a radio button, <input data-testid="small">. A person unchecks a radio button by choosing another one, so check that one instead.`,
    details: { element: '<input data-testid="small">' },
  })
  assert.ok(ms < 1000, `took ${ms} ms`)
  assert.equal((await observe(page, 'clicks-heard')).text, '')
  assert.deepEqual(await check(page, byLabel('Large')), { ok: true, kind: 'check', changed: true, page: facts })
  assert.match((await observe(page, 'checks-shown')).text ?? '', /small=false large=true/)
})

test('a covered checkbox is not checked, and no listener of the page hears any part of a click', async (t) => {
  const { page } = await choicesPage(t)
  assert.deepEqual(failureOf(await check(page, 'covered', 300)), {
    class: 'not_actionable',
    message: `Could not check getByTestId('covered') within 300 ms: another element, <span class="cover" data-testid="cover">, covers its centre.`,
    details: { check: 'hit-target', covering: '<span class="cover" data-testid="cover">', waitedMs: 300 },
  })
  assert.deepEqual(failureOf(await check(page, 'hover-covered')), {
    class: 'not_actionable',
    message: `Could not check getByTestId('hover-covered'): another element, <span class="cover" data-testid="hover-cover">, was on top of it when Retest pressed. Retest stopped the click before the page received it.`,
    details: { check: 'hit-target', interceptedBy: '<span class="cover" data-testid="hover-cover">', event: 'pointerdown' },
  })
  assert.equal((await observe(page, 'pointer-heard')).text, '')
  assert.match((await observe(page, 'checks-shown')).text ?? '', /covered=false/)
})

async function scrollPage(t: TestContext, options: Parameters<typeof openPage>[3] = {}) {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url, options)
  assertOk(await goto(page, '/actions/scroll'))
  return { app, page, facts: { url: `${app.url}/actions/scroll`, title: 'Scroll' } }
}

test('the wheel turned at the centre of the viewport scrolls the page, which loads more items once', async (t) => {
  const { app, page, facts } = await scrollPage(t)
  assert.equal((await observe(page, 'items-count')).text, '20')
  assert.deepEqual(await scroll(page, undefined, { y: 5000 }), { ok: true, kind: 'scroll', page: facts })
  await observeUntil(page, 'items-count', (seen) => seen.text === '30')
  assert.equal(app.loads(), 1)
  assert.match((await observe(page, 'wheels-heard')).text ?? '', /^[^ ]+$/, 'the page heard one wheel')
})

test('the wheel turned on the terms scrolls them to their end, which enables Accept', async (t) => {
  const { page, facts } = await scrollPage(t)
  assert.equal((await observe(page, 'accept-state')).text, 'disabled')
  assert.deepEqual(await scroll(page, 'terms', { y: 2000 }), { ok: true, kind: 'scroll', page: facts })
  await observeUntil(page, 'accept-state', (seen) => seen.text === 'enabled')
  assertOk(await click(page, 'accept'))
})

test('a scroll delta is in CSS pixels, also on a phone page zoomed out to fit, where the wheel still scrolls', async (t) => {
  const phone = { emulation: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, touch: true, isMobile: true } }
  for (const options of [{}, phone]) {
    const { page } = await scrollPage(t, options)
    assertOk(await scroll(page, 'terms', { y: 60 }))
    await observeUntil(page, 'terms-scrolled', (seen) => Math.abs(Number(seen.text) - 60) <= 2)
  }
})

test('a covered list is not scrolled, and no listener of the page hears the wheel', async (t) => {
  const { page } = await scrollPage(t)
  assert.deepEqual(failureOf(await scroll(page, 'covered-list', { y: 100 }, 300)), {
    class: 'not_actionable',
    message: `Could not scroll getByTestId('covered-list') within 300 ms: another element, <div class="cover" data-testid="list-cover">, covers its centre.`,
    details: { check: 'hit-target', covering: '<div class="cover" data-testid="list-cover">', waitedMs: 300 },
  })
  assert.equal((await observe(page, 'wheels-heard')).text, '')
})

test('a scroll with no distance is usage, and sends nothing', async (t) => {
  const { page } = await scrollPage(t)
  const failure = failureOf(await scroll(page, 'terms', {}))
  assert.equal(failure.class, 'usage')
  assert.equal(failure.message, 'scroll() takes x and y in CSS pixels, one of them other than 0, received { x: 0, y: 0 }.')
  assert.equal((await observe(page, 'wheels-heard')).text, '')
})

// The page tells Retest when its document changes, so a look that waits for a change answers when the change
// comes, not on a timer, and a look at a page that does not change answers when its wait runs out.
test('an observe with after answers on the next change, or after waitMs when nothing changes', async (t) => {
  const { page } = await taskPage(t, { mode: 'delayed', delayMs: 600 })
  const first = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'saved-task' } }, 2000)
  assert.ok(first.ok && first.kind === 'observe' && first.changes !== undefined, JSON.stringify(first))
  const quiet = await timed(page.execute({ kind: 'observe', locator: { by: 'testId', value: 'saved-task' }, after: { changes: first.changes, waitMs: 300 } }, 2000))
  assert.ok(quiet.value.ok && quiet.value.kind === 'observe', JSON.stringify(quiet.value))
  assert.ok(quiet.ms >= 290 && quiet.ms < 700, `a quiet page answered after ${quiet.ms} ms`)
  assert.ok(quiet.value.waitedMs !== undefined && quiet.value.waitedMs >= 290, `waited ${quiet.value.waitedMs} ms`)
  assert.equal(quiet.value.changes, first.changes)

  assertOk(await fill(page, 'task-title', 'Release checklist'))
  assertOk(await click(page, 'save-task'))
  // The click showed "Saving…" at once; the server's answer, 600 ms later, is the change the next look waits for.
  const saving = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'saved-task' } }, 2000)
  assert.ok(saving.ok && saving.kind === 'observe' && saving.changes !== undefined, JSON.stringify(saving))
  assert.ok(saving.changes > first.changes, 'the click changed the document')
  const saved = await timed(page.execute({ kind: 'observe', locator: { by: 'testId', value: 'saved-task' }, after: { changes: saving.changes, waitMs: 3000 } }, 5000))
  assert.ok(saved.value.ok && saved.value.kind === 'observe', JSON.stringify(saved.value))
  assert.equal(saved.value.observation.text, 'Release checklist')
  assert.ok(saved.ms < 1500, `the saved text was seen only after ${saved.ms} ms`)
  assert.ok(saved.value.waitedMs !== undefined && saved.value.waitedMs >= 300 && saved.value.waitedMs < 1500, `waited ${saved.value.waitedMs} ms`)
})
