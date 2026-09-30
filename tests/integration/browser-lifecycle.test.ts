import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Failure } from '../../src/protocol/failures.ts'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { closeGraceMs } from '../../src/browser/contract.ts'
import {
  assertOk,
  awaitPosts,
  browserPath,
  byTestId,
  click,
  closeMs,
  failureOf,
  goto,
  groupExists,
  launch,
  observe,
  observeUntil,
  openPage,
  processesUsing,
  profileOf,
  scratchFolder,
  servePages,
  setupMs,
  timed,
  waitForGroupEnd,
  within,
} from './browser-harness.ts'

// Posts to /pressed with a synchronous request, so the server knows the press arrived, then never returns.
const FREEZE_ON_PRESS = `<!doctype html><button data-testid="freeze" style="width: 200px; height: 60px">Freeze</button><script>
  document.querySelector('[data-testid="freeze"]').addEventListener('mousedown', () => {
    const request = new XMLHttpRequest()
    request.open('POST', '/pressed', false)
    request.send()
    for (;;) {}
  })
</script>`

// Tells the server, with a synchronous request, that it is about to spin forever.
const BUSY_AFTER_LOAD = `<!doctype html><p data-testid="text">Busy</p><script>
  addEventListener('load', () => setTimeout(() => {
    const request = new XMLHttpRequest()
    request.open('POST', '/busy', false)
    request.send()
    for (;;) {}
  }, 50))
</script>`

// A disabled button below the fold: Retest scrolls it into view on its first look, which the page reports,
// and then waits for it to be enabled.
const FAR_AND_DISABLED = `<!doctype html><div style="height: 3000px"></div><button data-testid="far" disabled>Far</button><script>
  addEventListener('scroll', () => fetch('/looked', { method: 'POST' }), { once: true })
</script>`

// The button is enabled only once the one above it is clicked, and says when it is clicked itself.
const ENABLED_LATER = `<!doctype html><button data-testid="enable">Enable</button><div style="height: 3000px"></div>
<button data-testid="far" disabled>Far</button><script>
  const far = document.querySelector('[data-testid="far"]')
  addEventListener('scroll', () => fetch('/looked', { method: 'POST' }), { once: true })
  document.querySelector('[data-testid="enable"]').addEventListener('click', () => { far.disabled = false })
  far.addEventListener('click', () => fetch('/clicked', { method: 'POST' }))
</script>`

// Tells the server the press arrived, then keeps the page busy long enough for Retest to be stopped mid-click.
const BUSY_ON_PRESS = `<!doctype html><button data-testid="hold" style="width: 200px; height: 60px">Hold</button>
<p data-testid="status">idle</p><script>
  const hold = document.querySelector('[data-testid="hold"]')
  const status = document.querySelector('[data-testid="status"]')
  hold.addEventListener('mousedown', () => {
    status.textContent = 'pressed'
    const request = new XMLHttpRequest()
    request.open('POST', '/pressed', false)
    request.send()
    const end = performance.now() + 1500
    while (performance.now() < end) {}
  })
  hold.addEventListener('mouseup', () => { status.textContent += ' released' })
  hold.addEventListener('click', () => { status.textContent += ' clicked' })
</script>`

const interrupted: Failure = { class: 'interrupted', message: 'The run was interrupted.' }

const STORAGE = `<!doctype html><p data-testid="before"></p><script>
  document.querySelector('[data-testid="before"]').textContent = (localStorage.getItem('seen') ?? 'nothing') + ' ' + (document.cookie || 'no cookie')
  localStorage.setItem('seen', 'stored')
  document.cookie = 'visit=1'
</script>`

test('launch reports the browser that ran and owns a process group and a profile', async (t) => {
  const browser = await launch(t)
  assert.equal(browser.product, 'Chrome')
  assert.match(browser.version, /^\d+\.\d+\.\d+\.\d+$/)
  assert.match(browser.userAgent, /Chrome\/\d+/)
  assert.equal(browser.connected, true)
  const profile = await profileOf(browser.pid)
  assert.ok(existsSync(profile))
  const running = await processesUsing(profile)
  assert.ok(running.length > 0)
  const groups = new Set(running.map((line) => line.trim().split(/\s+/)[1]))
  assert.deepEqual([...groups], [String(browser.pid)], 'every browser process should be in the browser process group')
})

test('close ends every process of the browser and removes its profile', async (t) => {
  const browser = await launch(t)
  const profile = await profileOf(browser.pid)
  const reasons: string[] = []
  browser.onDisconnect((reason) => reasons.push(reason))
  const closing = browser.close(closeMs)
  assert.equal(browser.close(closeMs), closing, 'a second close waits for the same work')
  await closing
  assert.equal(groupExists(browser.pid), false)
  assert.deepEqual(await processesUsing(profile), [])
  assert.equal(existsSync(profile), false)
  assert.equal(browser.connected, false)
  assert.deepEqual(reasons, ['Retest closed the browser'])
})

test('a killed browser tells each disconnect listener once, including one added afterwards', async (t) => {
  const browser = await launch(t)
  const reasons: string[] = []
  const heard = Promise.withResolvers<void>()
  browser.onDisconnect((reason) => {
    reasons.push(`first: ${reason}`)
    heard.resolve()
  })
  const removed = browser.onDisconnect(() => reasons.push('removed'))
  removed()
  process.kill(-browser.pid, 'SIGKILL')
  await within(heard.promise, 5000, 'the listener never heard of the disconnect')
  assert.equal(browser.connected, false)
  const late = new Promise<string>((resolve) => browser.onDisconnect(resolve))
  assert.equal(await late, reasons[0]?.replace('first: ', ''))
  // Closing waits for the process to exit, so both the closed pipe and the exit have been heard by now.
  await browser.close(closeMs)
  assert.equal(reasons.length, 1)
  assert.match(reasons[0] ?? '', /^first: the browser (closed the pipe|process ended with signal SIGKILL)$/)
})

test('killing the browser while an action waits for its element fails as a lost session', async (t) => {
  const site = await servePages(t, { '/': FAR_AND_DISABLED })
  const browser = await launch(t)
  const page = await openPage(t, browser, site.url)
  assertOk(await goto(page, '/'))
  const clicking = timed(click(page, 'far', 10_000))
  await awaitPosts(site, '/looked', 1)
  process.kill(-browser.pid, 'SIGKILL')
  const { value, ms } = await clicking
  const failure = failureOf(value)
  assert.equal(failure.class, 'session_lost')
  assert.match(failure.message, /^Retest lost the page before it could click getByTestId\('far'\): /)
  assert.ok(ms < 3000, `the loss should end the wait, took ${ms} ms`)
})

test('killing the browser after the press was sent leaves the outcome unknown', async (t) => {
  const site = await servePages(t, { '/': FREEZE_ON_PRESS })
  const browser = await launch(t)
  const page = await openPage(t, browser, site.url)
  assertOk(await goto(page, '/'))
  const clicking = click(page, 'freeze', 10_000)
  await awaitPosts(site, '/pressed', 1)
  process.kill(-browser.pid, 'SIGKILL')
  const failure = failureOf(await clicking)
  assert.equal(failure.class, 'outcome_unknown')
  assert.match(failure.message, /^Retest lost the page after it began to click getByTestId\('freeze'\), so it cannot tell/)
  assert.equal(site.posts('/pressed'), 1)
})

test('a click stopped before it pressed ends at once, sends nothing and says so', async (t) => {
  const site = await servePages(t, { '/': ENABLED_LATER })
  const browser = await launch(t)
  const page = await openPage(t, browser, site.url)
  assertOk(await goto(page, '/'))
  const stop = new AbortController()
  const clicking = timed(page.execute({ kind: 'click', locator: byTestId('far') }, 10_000, stop.signal))
  await awaitPosts(site, '/looked', 1)
  stop.abort(interrupted)
  const { value, ms } = await clicking
  assert.deepEqual(failureOf(value), {
    class: 'interrupted',
    message: "The run was interrupted. Retest stopped before it could click getByTestId('far'), and sent nothing.",
    details: { inputSent: false },
  })
  assert.ok(ms < 1000, `the click should end when stopped, took ${ms} ms`)
  assertOk(await click(page, 'enable'))
  assertOk(await click(page, 'far'))
  await awaitPosts(site, '/clicked', 1)
  assert.equal((await observe(page, 'far')).count, 1)
  assert.equal(site.posts('/clicked'), 1, 'only the later click reached the button')
})

test('a click stopped after its press was sent is never released, and says the press was sent', async (t) => {
  const site = await servePages(t, { '/': BUSY_ON_PRESS })
  const browser = await launch(t)
  const page = await openPage(t, browser, site.url)
  assertOk(await goto(page, '/'))
  const stop = new AbortController()
  const clicking = timed(page.execute({ kind: 'click', locator: byTestId('hold') }, 10_000, stop.signal))
  await awaitPosts(site, '/pressed', 1)
  stop.abort(interrupted)
  const { value, ms } = await clicking
  assert.deepEqual(failureOf(value), {
    class: 'interrupted',
    message:
      "The run was interrupted. Retest had already begun to click getByTestId('hold'). Input it sent is not taken back, so it may have taken effect.",
    details: { inputSent: true },
  })
  assert.ok(ms < 1500, `the click should end while the page is still busy, took ${ms} ms`)
  // The page answers once its press handler returns; a release sent before the stop would have been handled first.
  assert.equal((await observe(page, 'status')).text, 'pressed')
  assert.equal((await observe(page, 'status')).text, 'pressed')
})

test('a command stopped before it starts sends nothing', async (t) => {
  const site = await servePages(t, { '/': ENABLED_LATER })
  const browser = await launch(t)
  const page = await openPage(t, browser, site.url)
  const stop = new AbortController()
  stop.abort(interrupted)
  const failure = failureOf(await page.execute({ kind: 'goto', url: '/' }, 5000, stop.signal))
  assert.deepEqual([failure.class, failure.details], ['interrupted', { inputSent: false }])
  assert.equal(failure.message, `The run was interrupted. Retest stopped before it could open ${site.url}/, and sent nothing.`)
  assert.equal((await observe(page, 'enable')).count, 0, 'the page is still blank')
  assertOk(await goto(page, '/'))
  assert.equal((await observe(page, 'enable')).count, 1)
})

test('closing within a budget too short to close gracefully still ends the browser within the close grace', async (t) => {
  const browser = await launch(t)
  const profile = await profileOf(browser.pid)
  const { ms } = await timed(browser.close(1))
  assert.ok(ms < 1 + closeGraceMs + 500, `took ${ms} ms`)
  assert.equal(groupExists(browser.pid), false)
  assert.equal(existsSync(profile), false)
})

test('a page that cannot open within its budget fails as a setup failure, and the browser stays usable', async (t) => {
  const browser = await launch(t)
  const refused = await browser.newPage({}, 1).then(
    () => undefined,
    (error: unknown) => error,
  )
  assert.ok(refused instanceof BrowserError, String(refused))
  assert.equal(refused.failure.class, 'setup_failed')
  assert.match(refused.failure.message, /^Could not open a page: \S+ got no response within 1 ms$/)
  const site = await servePages(t, { '/': '<!doctype html><p data-testid="text">Here</p>' })
  const page = await openPage(t, browser, site.url)
  assertOk(await goto(page, '/'))
  assert.equal((await observe(page, 'text')).text, 'Here')
})

test('once the browser is gone, commands fail at once, new pages are refused and cleanup still completes', async (t) => {
  const browser = await launch(t)
  const profile = await profileOf(browser.pid)
  const page = await openPage(t, browser)
  process.kill(-browser.pid, 'SIGKILL')
  await waitForGroupEnd(browser.pid)
  await within(new Promise((resolve) => browser.onDisconnect(resolve)), 5000, 'the browser never reported the disconnect')
  const { value, ms } = await timed(observe(page, 'anything').catch(() => undefined))
  assert.equal(value, undefined, 'observe should fail')
  assert.ok(ms < 500, `took ${ms} ms`)
  const failure = failureOf(await page.execute({ kind: 'click', locator: { by: 'testId', value: 'anything' } }, 5000))
  assert.equal(failure.class, 'session_lost')
  const refused = await browser.newPage({}, setupMs).then(
    () => undefined,
    (error: unknown) => error,
  )
  assert.ok(refused instanceof BrowserError, String(refused))
  assert.equal(refused.failure.class, 'session_lost')
  await page.dispose(1000)
  await browser.close(closeMs)
  assert.equal(existsSync(profile), false)
})

test('a press the page never confirms times out once, says it was sent, and is not sent again', async (t) => {
  const site = await servePages(t, { '/': FREEZE_ON_PRESS })
  const browser = await launch(t)
  const page = await browser.newPage({ baseUrl: site.url }, setupMs)
  assertOk(await goto(page, '/'))
  const failure = failureOf(await click(page, 'freeze', 1000))
  assert.equal(failure.class, 'timeout')
  assert.deepEqual(failure.details, { inputSent: true })
  assert.match(failure.message, /did not confirm it within 1000 ms\. It may or may not have taken effect\.$/)
  const { ms } = await timed(page.dispose(3000))
  assert.ok(ms < 3000)
  // The page is gone, so no second press can reach the server after this.
  assert.equal(site.posts('/pressed'), 1)
})

test('a page busy in a loop times out without input and can still be closed', async (t) => {
  const site = await servePages(t, { '/': BUSY_AFTER_LOAD })
  const browser = await launch(t)
  const page = await browser.newPage({ baseUrl: site.url }, setupMs)
  assertOk(await goto(page, '/'))
  await awaitPosts(site, '/busy', 1)
  const read = failureOf(await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'text' } }, 500))
  assert.equal(read.class, 'timeout')
  assert.equal(read.message, "The page did not answer within 500 ms while Retest tried to read getByTestId('text').")
  const press = failureOf(await click(page, 'text', 500))
  assert.deepEqual([press.class, press.details], ['timeout', { inputSent: false }])
  await assert.rejects(page.screenshot(300), (error) => error instanceof BrowserError && error.failure.class === 'timeout')
  await page.dispose(3000)
})

test('a page whose renderer crashes fails the command waiting on it at once, and later ones too', async (t) => {
  const site = await servePages(t, { '/': BUSY_AFTER_LOAD })
  const browser = await launch(t)
  const page = await openPage(t, browser, site.url)
  assertOk(await goto(page, '/'))
  await awaitPosts(site, '/busy', 1)
  const reading = timed(page.execute({ kind: 'observe', locator: { by: 'testId', value: 'text' } }, 10_000))
  const renderers = (await processesUsing(await profileOf(browser.pid)))
    .filter((line) => line.includes('--type=renderer'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
  assert.ok(renderers.length > 0, 'the page has a renderer process')
  for (const pid of renderers) process.kill(pid, 'SIGKILL')

  const { value, ms } = await reading
  assert.ok(ms < 5000, `the read waiting on the crashed page should fail at once, took ${ms} ms of 10000`)
  const read = failureOf(value)
  assert.equal(read.class, 'session_lost')
  assert.match(read.message, /the page crashed/)
  const later = await timed(click(page, 'text', 10_000))
  assert.ok(later.ms < 500, `a command after the crash should fail at once, took ${later.ms} ms`)
  assert.equal(failureOf(later.value).class, 'session_lost')
  assert.equal(browser.connected, true, 'the browser itself is still there')
})

test('disposing a page ends only that page, and is safe to repeat', async (t) => {
  const site = await servePages(t, { '/': '<!doctype html><p data-testid="text">Here</p>' })
  const browser = await launch(t)
  const first = await browser.newPage({ baseUrl: site.url }, setupMs)
  const second = await openPage(t, browser, site.url)
  assertOk(await goto(first, '/'))
  assertOk(await goto(second, '/'))
  const disposing = first.dispose(2000)
  assert.equal(first.dispose(2000), disposing)
  await disposing
  const failure = failureOf(await first.execute({ kind: 'observe', locator: { by: 'testId', value: 'text' } }, 1000))
  assert.equal(failure.class, 'session_lost')
  assert.match(failure.message, /the page was closed\.$/)
  await assert.rejects(first.screenshot(1000), (error) => {
    assert.ok(error instanceof BrowserError)
    assert.deepEqual(error.failure, {
      class: 'session_lost',
      message: 'Retest lost the page before it could take a screenshot: the page was closed.',
      details: { reason: 'the page was closed' },
    })
    return true
  })
  assert.equal((await observe(second, 'text')).text, 'Here')
})

test('each page starts with empty storage and cookies', async (t) => {
  const site = await servePages(t, { '/': STORAGE })
  const browser = await launch(t)
  const first = await openPage(t, browser, site.url)
  assertOk(await goto(first, '/'))
  assertOk(await goto(first, '/'))
  await observeUntil(first, 'before', (seen) => seen.text === 'stored visit=1')
  const second = await openPage(t, browser, site.url)
  assertOk(await goto(second, '/'))
  assert.equal((await observe(second, 'before')).text, 'nothing no cookie')
})

async function launchInChild(t: TestContext, mode: 'exit' | 'wait') {
  const folder = await scratchFolder(t)
  const launchModule = new URL('../../src/browser/launch.ts', import.meta.url).href
  const script = `
    import { launchBrowser } from ${JSON.stringify(launchModule)}
    const browser = await launchBrowser({ executablePath: process.env.RETEST_BROWSER, logFile: process.env.RETEST_LOG, headless: true })
    process.stdout.write(browser.pid + '\\n')
    if (process.env.RETEST_MODE === 'exit') process.stdin.once('data', () => process.exit(3))
    else setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['--conditions=retest-source', '--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, RETEST_BROWSER: browserPath(), RETEST_LOG: join(folder, 'browser.log'), RETEST_MODE: mode },
  })
  const exited = once(child, 'exit')
  t.after(() => child.kill('SIGKILL'))
  const [line] = await once(child.stdout, 'data')
  const pid = Number(String(line).trim())
  assert.ok(Number.isInteger(pid) && pid > 0, `the child printed ${String(line)}`)
  const profile = await profileOf(pid)
  t.after(async () => {
    signalGroup(pid, 'SIGKILL')
    await rm(profile, { recursive: true, force: true })
  })
  t.diagnostic(`child ${child.pid} launched browser ${pid} with profile ${profile}`)
  return { child, exited, pid, profile }
}

test('when the owning process exits without closing the browser, the browser group is killed', async (t) => {
  const { child, exited, pid, profile } = await launchInChild(t, 'exit')
  assert.equal(groupExists(pid), true)
  child.stdin?.write('go\n')
  const [code] = await exited
  assert.equal(code, 3, 'the exit code the process chose is kept')
  await waitForGroupEnd(pid, 2000)
  assert.equal(existsSync(profile), false)
})

test('when the owning process is killed outright, the browser exits because its pipe closed, and the next launch removes its profile', async (t) => {
  const { child, exited, pid, profile } = await launchInChild(t, 'wait')
  assert.match(profile, new RegExp(`/retest-profile-${child.pid}-[A-Za-z0-9]+$`), 'the profile names the process that owns it')
  child.kill('SIGKILL')
  await exited
  await waitForGroupEnd(pid, 10_000)
  assert.deepEqual(await processesUsing(profile), [])
  assert.equal(existsSync(profile), true, 'nothing was left to remove it')
  const next = await launch(t)
  assert.equal(existsSync(profile), false, 'the next launch removed the profile of the process that is gone')
  assert.match(await profileOf(next.pid), new RegExp(`/retest-profile-${process.pid}-[A-Za-z0-9]+$`))
})
