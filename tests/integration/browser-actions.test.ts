import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { TaskApp, TaskAppOptions } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import {
  assertOk,
  click,
  failureOf,
  fill,
  goto,
  observe,
  observeUntil,
  openApp,
  openPage,
  servePages,
  sharedBrowser,
  timed,
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
