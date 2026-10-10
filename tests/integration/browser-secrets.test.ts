import type { TestContext } from 'node:test'
import type { OwnedBrowser, OwnedPage } from '../../src/browser/contract.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { registrationFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import {
  assertOk,
  byLabel,
  byTestId,
  click,
  closeMs,
  failureOf,
  fill,
  goto,
  launchEngine,
  launchGated,
  observe,
  observeUntil,
  openApp,
  openPage,
  servePages,
  type Pages,
  type Target,
} from './browser-harness.ts'
import { engineExpectations } from './engine-expectations.ts'
import { launchWithGate, protocolOnly } from './engines.ts'

const value = 'hunter2-never-shown'
const secret = 'password'

// Cases another engine ends otherwise assert through this, which holds Chrome's outcome or the engine's declared one.
const engineCase = engineExpectations('browser-secrets')

let browser: OwnedBrowser | undefined
let folder: string | undefined

// A browser of this file's own, so its log can be searched for the values once it closes.
before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'retest-browser-test-'))
  browser = await launchEngine(join(folder, 'browser.log'))
})

after(async () => {
  await browser?.close(closeMs)
  if (folder === undefined) return
  const log = await readFile(join(folder, 'browser.log'), 'utf8')
  await rm(folder, { recursive: true, force: true })
  assert.ok(!log.includes(value) && !log.includes(TASK_APP_PASSWORD), 'the browser log holds a secret value')
})

function launched(): OwnedBrowser {
  assert.ok(browser !== undefined, 'the browser did not launch')
  return browser
}

function fillSecret(page: OwnedPage, target: Target, typed: string, timeoutMs = 2000, signal?: AbortSignal): Promise<CommandResult> {
  const locator = typeof target === 'string' ? byTestId(target) : target
  return page.execute({ kind: 'fill', locator, value: typed, secret }, timeoutMs, signal)
}

// A failure is written to events, results and reports, so the value must be nowhere in it.
function hidden(result: CommandResult): Failure {
  const failure = failureOf(result)
  assert.ok(!JSON.stringify(failure).includes(value), `the failure shows the secret: ${JSON.stringify(failure)}`)
  return failure
}

async function customPage(t: TestContext, body: string): Promise<OwnedPage> {
  const site = await servePages(t, { '/': `<!doctype html><meta charset="utf-8"><body>${body}</body>` })
  const page = await openPage(t, launched(), site.url)
  assertOk(await goto(page, '/'))
  return page
}

test('a secret is typed like any value, and the sign-in it completes succeeds', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, launched(), app.url)
  assertOk(await goto(page, '/login'))
  assertOk(await fill(page, byLabel('User name'), 'alice'))
  assert.deepEqual(await fillSecret(page, byLabel('Password'), TASK_APP_PASSWORD), { ok: true, kind: 'fill', page: { url: `${app.url}/login`, title: 'Sign in' } })
  assertOk(await click(page, 'sign-in'))
  await observeUntil(page, 'account', (seen) => seen.text === 'Signed in as alice')
})

test('a secret with a line break is refused for an input by the name of the secret, never by its value', async (t) => {
  const page = await customPage(t, '<input type="password" data-testid="field">')
  const failure = hidden(await fillSecret(page, 'field', `${value}\nsecond line`))
  assert.equal(failure.class, 'unsupported')
  assert.equal(
    failure.message,
    `Could not fill getByTestId('field') with {{password}}, which has a line break: it is <input type="password">, which holds one line. Use a textarea for text with \\n or \\r.`,
  )
})

test('failures to find or ready a field for a secret never show the value', async (t) => {
  const page = await customPage(t, '<input data-testid="locked" disabled><input data-testid="first"><input data-testid="first">')
  assert.equal(hidden(await fillSecret(page, 'missing', value, 300)).class, 'not_found')
  assert.equal(hidden(await fillSecret(page, 'locked', value, 300)).class, 'not_actionable')
  assert.equal(hidden(await fillSecret(page, 'first', value, 300)).class, 'ambiguous')
})

test('a secret fill that is stopped names the secret by its label', async (t) => {
  const page = await customPage(t, '<input data-testid="later" disabled>')
  const stop = new AbortController()
  setTimeout(() => stop.abort({ class: 'timeout', message: 'The test ran out of time.' }), 100)
  const failure = hidden(await fillSecret(page, 'later', value, 5000, stop.signal))
  assert.equal(failure.class, 'timeout')
  assert.equal(failure.message, 'The test ran out of time. Retest stopped before it could fill getByTestId(\'later\') with {{password}}, and sent nothing.')
})

test('a dialog that opens while a secret is typed names the secret by its label', async (t) => {
  const page = await customPage(
    t,
    `<input data-testid="field"><script>
      document.querySelector('[data-testid="field"]').addEventListener('input', () => alert('Typed'))
    </script>`,
  )
  const failure = hidden(await fillSecret(page, 'field', value, 5000))
  assert.equal(failure.class, 'unsupported')
  assert.equal(
    failure.message,
    "The page opened an alert dialog while Retest tried to fill getByTestId('field') with {{password}}. Retest does not answer dialogs yet, and the dialog blocks the page.",
  )
})

function fillBound(page: OwnedPage, allowedOrigins: readonly string[], timeoutMs = 2000): Promise<CommandResult> {
  return page.execute({ kind: 'fill', locator: byTestId('field'), value, secret, allowedOrigins }, timeoutMs)
}

// The POST requests to `path` the server has counted once there are `count` of them, or once `timeoutMs` has passed.
async function postsWithin(site: Pages, path: string, count: number, timeoutMs = 5000): Promise<number> {
  const end = performance.now() + timeoutMs
  while (site.posts(path) < count && performance.now() <= end) await delay(10)
  return site.posts(path)
}

// Each page reports text that reaches its field, so a page the secret never reached is one that sent nothing.
const reportsTyping = `<script>
  document.querySelector('[data-testid="field"]').addEventListener('input', () => fetch('/typed', { method: 'POST' }))
</script>`

test('a page that sets off for another origin as the field takes focus is kept where it is, and the secret is never typed', async (t) => {
  const elsewhere = await servePages(t, { '/': `<!doctype html><input data-testid="field" autofocus>${reportsTyping}` })
  const site = await servePages(t, {
    '/': `<!doctype html><input data-testid="field">${reportsTyping}<script>
      document.querySelector('[data-testid="field"]').addEventListener('focus', () => { location.href = ${JSON.stringify(`${elsewhere.url}/`)} })
      navigation.addEventListener('navigateerror', () => fetch('/cancelled', { method: 'POST' }))
    </script>`,
  })
  const page = await openPage(t, launched(), site.url)
  const visited: string[] = []
  page.onNavigation((navigation) => void visited.push(navigation.url))
  assertOk(await goto(page, '/'))
  const filling = await fillBound(page, [site.url])
  await t.test('the refusal names the attempted origin', () => {
    const failure = hidden(filling)
    assert.deepEqual(failure, {
      class: 'not_actionable',
      message: `Could not fill getByTestId('field') with {{password}}: the page started to open ${elsewhere.url} before Retest typed. Retest kept the page where it was and did not type {{password}}.`,
      details: { origin: elsewhere.url, leaving: true },
    })
  })
  // A cancelled navigation is over: the page hears of it, and never opens the other origin afterwards. Each check is a
  // subtest, so the rest still run, after the first has waited its time, on an engine whose page cannot hear of it.
  await t.test('the page hears that its navigation was cancelled', async (each) => {
    engineCase.assertOutcome(each, await postsWithin(site, '/cancelled', 1), 1)
  })
  await t.test('the field is empty, the page never left, and no origin received typing', async (checks) => {
    await checks.test('the field is empty', async () => {
      assert.equal((await observe(page, 'field')).value, '')
    })
    await checks.test('the page never left', () => {
      assert.deepEqual(visited, [`${site.url}/`], 'the page never left')
    })
    await checks.test('no origin received typing', () => {
      assert.deepEqual([site.posts('/typed'), elsewhere.posts('/typed')], [0, 0])
    })
  })
})

test('a page already on another origin is refused by the page itself, whatever the parent last saw', async (t) => {
  const site = await servePages(t, { '/': `<!doctype html><input data-testid="field">${reportsTyping}` })
  const page = await openPage(t, launched(), site.url)
  assertOk(await goto(page, '/'))
  const allowed = 'https://app.example'
  const failure = hidden(await fillBound(page, [allowed, allowed]))
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: `Could not fill getByTestId('field') with {{password}}: the page is on ${site.url}, and {{password}} may be typed only on ${allowed}. Retest did not type it.`,
    details: { origin: site.url },
  })
  assert.equal((await observe(page, 'field')).value, '')
  assert.equal(site.posts('/typed'), 0)
})

test('a fill bound to its origin still lets the page move within the document, and leave once the text has arrived', async (t) => {
  const site = await servePages(t, {
    '/': `<!doctype html><input data-testid="field">${reportsTyping}<script>
      const field = document.querySelector('[data-testid="field"]')
      field.addEventListener('focus', () => history.pushState(null, '', '/focused'))
      field.addEventListener('input', () => { location.href = '/done' })
    </script>`,
    '/done': '<!doctype html><p data-testid="done">Done</p>',
  })
  const page = await openPage(t, launched(), site.url)
  assertOk(await goto(page, '/'))
  // The field's focus moved the page to /focused within the document, and the fill names the page it typed on.
  const filled = await fillBound(page, [site.url])
  await t.test('the fill names the document it typed on', () => {
    assert.deepEqual(filled, { ok: true, kind: 'fill', page: { url: `${site.url}/focused` } })
  })
  await t.test('the page leaves after receiving the text once', async (checks) => {
    await checks.test('the next document arrives', async () => {
      await observeUntil(page, 'done', (seen) => seen.text === 'Done')
    })
    await checks.test('the text reached one request', (each) => {
      engineCase.assertOutcome(each, site.posts('/typed'), 1)
    })
  })
})

test('a fill waits for its verdict request to enter the document before input can replace it', async (t) => {
  if (!protocolOnly(t, 'chromium', 'the gate holds a DevTools verdict request')) return
  const site = await servePages(t, {
    '/': `<!doctype html><input data-testid="field">${reportsTyping}<script>
      const field = document.querySelector('[data-testid="field"]')
      field.addEventListener('focus', () => history.pushState(null, '', '/focused'))
      field.addEventListener('input', () => { location.href = '/done' })
    </script>`,
    '/done': '<!doctype html><p data-testid="done">Done</p>',
  })
  let verdictHeld = false
  let verdictReleased = false
  let registrationAsked = false
  let textDispatched = false
  const browser = await launchGated(t, {
    hold(method, params) {
      const source = isRecord(params) ? params['functionDeclaration'] : undefined
      if (method === 'Runtime.callFunctionOn' && source === verdictFunction) {
        verdictHeld = true
        // Independent of input and navigation: the Runtime handler reaches the browser after this delay.
        return delay(150).then(() => { verdictReleased = true })
      }
      if (method === 'Runtime.callFunctionOn' && source === registrationFunction) registrationAsked = true
      if (method === 'Input.insertText') {
        assert.ok(registrationAsked && verdictReleased, 'text cannot overtake the pending verdict request')
        textDispatched = true
      }
      return undefined
    },
  })
  const page = await openPage(t, browser, site.url)
  assertOk(await goto(page, '/'))
  assert.deepEqual(await fillBound(page, [site.url]), { ok: true, kind: 'fill', page: { url: `${site.url}/focused` } })
  await observeUntil(page, 'done', (seen) => seen.text === 'Done')
  assert.equal(site.posts('/typed'), 1)
  assert.ok(verdictHeld && textDispatched, 'the proof delayed a real verdict request and then sent text')
})

// A page whose load handler sends the browser to another origin, so the navigation is already under way when
// the fill begins: the case the guard in the page cannot hold, since the page began it before the guard armed.
function leavingOnLoad(destination: string): string {
  return `<!doctype html><input data-testid="field">${reportsTyping}<script>
    addEventListener('load', () => { location.href = ${JSON.stringify(destination)} })
  </script>`
}

const autofocused = `<!doctype html><input data-testid="field" autofocus>${reportsTyping}`

// Found in the milestone 2 review: before this, the text went into the document about to be replaced, and a
// document that arrived first took it.
test('a fill that begins while the page is opening another document waits for that document, whose origin decides', async (t) => {
  const elsewhere = await servePages(t, { '/': autofocused }, { hold: () => delay(500) })
  const site = await servePages(t, { '/': leavingOnLoad(`${elsewhere.url}/`) })
  const page = await openPage(t, launched(), site.url)
  assertOk(await goto(page, '/'))
  const failure = hidden(await fillBound(page, [site.url], 5000))
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: `Could not fill getByTestId('field') with {{password}}: the page is on ${elsewhere.url}, and {{password}} may be typed only on ${site.url}. Retest did not type it.`,
    details: { origin: elsewhere.url },
  })
  assert.equal((await observe(page, 'field')).value, '', 'the field of the document that arrived is empty')
  assert.deepEqual([site.posts('/typed'), elsewhere.posts('/typed')], [0, 0])
})

test('a fill waiting for a document that never arrives fails when its time runs out, naming the address, and types nothing', async (t) => {
  const elsewhere = await servePages(t, { '/': autofocused }, { hold: () => new Promise(() => {}) })
  const site = await servePages(t, { '/': leavingOnLoad(`${elsewhere.url}/`) })
  const page = await openPage(t, launched(), site.url)
  assertOk(await goto(page, '/'))
  const failure = hidden(await fillBound(page, [site.url], 1000))
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: `Could not fill getByTestId('field') within 1000 ms: the page was still opening ${elsewhere.url}/, and Retest does not fill in a document about to be replaced.`,
    details: { check: 'navigation', url: `${elsewhere.url}/`, waitedMs: 1000 },
  })
  assert.deepEqual([site.posts('/typed'), elsewhere.posts('/typed')], [0, 0])
})

// Chrome holds Input.insertText while a navigation of the frame is pending and delivers it to the document that
// arrives. A navigation that begins after the page's ready answer, here one the browser starts, would take the
// text into that document; its own guard is what stops it, since nothing was armed there. The text is let go at
// that document's load, so its field must have the focus by then: autofocus waits for a rendering update, which
// comes after load, so the page focuses its field while it is parsed instead.
const focusedWhileParsed = `<!doctype html><input data-testid="field">${reportsTyping}<script>
  document.querySelector('[data-testid="field"]').focus()
</script>`

test('a document that arrives while the text is on its way never receives it, and the fill names that document', async (t) => {
  const sending = Promise.withResolvers<void>()
  const loaded = Promise.withResolvers<void>()
  const elsewhere = await servePages(t, { '/': focusedWhileParsed })
  const site = await servePages(t, { '/': `<!doctype html><input data-testid="field">${reportsTyping}` })
  const browser = await launchWithGate(t, {
    hold: (input) => {
      if (input !== 'text') return undefined
      sending.resolve()
      return loaded.promise
    },
    loaded: (url) => {
      if (url.startsWith(`${elsewhere.url}/`)) loaded.resolve()
    },
  }, 'the gate holds the text insertion back')
  if (browser === undefined) return
  const page = await openPage(t, browser, site.url)
  assertOk(await goto(page, '/'))
  const filling = fillBound(page, [site.url], 5000)
  await sending.promise
  assertOk(await goto(page, `${elsewhere.url}/`))
  const filled = await filling
  await t.test('the failure names the replacement document', () => {
    const failure = hidden(filled)
    assert.deepEqual(failure, {
      class: 'not_actionable',
      message: `Could not fill getByTestId('field') with {{password}}: the page moved to ${elsewhere.url} before the text arrived. Retest stopped the typing before that document received it, and typed nothing.`,
      details: { origin: elsewhere.url, moved: true },
    })
  })
  await t.test('the field of the replacement document is empty', async () => {
    assert.equal((await observe(page, 'field')).value, '', 'the field of the document that arrived is empty')
  })
  await t.test('neither origin received typing', () => {
    assert.deepEqual([site.posts('/typed'), elsewhere.posts('/typed')], [0, 0])
  })
})
