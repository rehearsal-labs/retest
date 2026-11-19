import type { IncomingHttpHeaders } from 'node:http'
import type { TestContext } from 'node:test'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { budgets, configSource, resultOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// Chrome for Testing and Chrome's headless shell of the same release, side by side through Retest: one app on each, the
// same tests on both, and what the page and its server saw compared. The shell is RETEST_TEST_HEADLESS_SHELL and Chrome
// is RETEST_TEST_CHROME_FOR_TESTING, never the test browser, which is Google Chrome in CI; without both nothing here runs.

const shell = process.env['RETEST_TEST_HEADLESS_SHELL']
const chrome = process.env['RETEST_TEST_CHROME_FOR_TESTING']
const skip = shell === undefined || shell === '' || chrome === undefined || chrome === ''
  ? 'set RETEST_TEST_HEADLESS_SHELL and RETEST_TEST_CHROME_FOR_TESTING to the headless shell and Chrome for Testing of one release'
  : false

// What a page with no viewport read in Retest 0.4.2 on Chrome for Testing 153.0.8010.12, measured through the published
// package on Linux x64 and Windows x64 and through its source on macOS arm64: a page Retest opened, and a window a page
// opened as a tab. The change of default must leave both as they were, on Chrome and on the shell.
const window042: Partial<Record<NodeJS.Platform, { readonly page: unknown; readonly tab: unknown }>> = {
  linux: { page: { viewport: [780, 437], window: [780, 580], screen: [800, 600, 800, 600], position: [20, 20] }, tab: { viewport: [780, 493], window: [780, 580], screen: [800, 600, 800, 600], position: [20, 20] } },
  darwin: { page: { viewport: [756, 413], window: [756, 556], screen: [800, 600, 800, 600], position: [44, 44] }, tab: { viewport: [756, 413], window: [756, 556], screen: [800, 600, 800, 600], position: [44, 44] } },
  win32: { page: { viewport: [764, 429], window: [780, 580], screen: [800, 600, 800, 600], position: [20, 20] }, tab: { viewport: [764, 485], window: [780, 580], screen: [800, 600, 800, 600], position: [20, 20] } },
}

// What a page reads of the browser, posted back to the server under the app's name, then shown in the title.
const probePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>probe</title><link rel="icon" href="data:,"></head><body>
<p id="mono" style="font-family: monospace; font-size: 16px; display: inline-block">The quick brown fox jumps over the lazy dog</p>
<script>
(async () => {
  const query = async (name) => (await navigator.permissions.query({ name })).state
  const mono = document.getElementById('mono').getBoundingClientRect()
  const high = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness'])
  const reading = {
    languages: navigator.languages, userAgent: navigator.userAgent,
    brands: navigator.userAgentData.brands, fullVersionList: high.fullVersionList,
    system: [navigator.userAgentData.platform, high.platformVersion, high.architecture, high.bitness],
    viewport: [innerWidth, innerHeight], window: [outerWidth, outerHeight], screen: [screen.width, screen.height, screen.availWidth, screen.availHeight], position: [screenX, screenY],
    permissions: { clipboardWrite: await query('clipboard-write'), backgroundSync: await query('background-sync'), screenWakeLock: await query('screen-wake-lock') },
    monospace: [mono.width, mono.height],
  }
  await fetch('/report?app=' + new URLSearchParams(location.search).get('app'), { method: 'POST', body: JSON.stringify(reading) })
  document.title = 'reported'
})()
</script><button data-testid="tab" onclick="window.open(location.pathname + '?app=' + new URLSearchParams(location.search).get('app') + '-tab')">Tab</button></body></html>`

const textPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Text</title><link rel="icon" href="data:,">
<style>body { margin: 8px; font: 16px/20px sans-serif; background: #fff } .serif { font-family: serif } .mono { font-family: monospace } .scroll { width: 160px; height: 60px; overflow: scroll }</style>
</head><body>
<p>Sans: The quick brown fox jumps over the lazy dog 0123456789</p>
<p class="serif">Serif: The quick brown fox jumps over the lazy dog</p>
<p class="mono">Mono: The quick brown fox jumps over the lazy dog</p>
<p><input value="A field"> <select><option>An option</option></select> <input type="checkbox" checked> <button>A button</button></p>
<div class="scroll"><div style="height: 200px; width: 300px">Scroll me</div></div>
</body></html>`

// Windows a page opens: from a click, from a timer a click started, from a link with a target, and from a timer the
// page started as it loaded, with no click behind it: `times` of them, one after another in one task, or with `apart`
// each in a task of its own, the next as soon as the page is free. Each blocked window's address names the app, the
// test and which window it is.
const opener = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Opener</title><link rel="icon" href="data:,"></head><body>
<button data-testid="now" onclick="window.open('/opened')">Open now</button>
<button data-testid="soon" onclick="setTimeout(() => window.open('/opened'), 300)">Open soon</button>
<a data-testid="link" href="/opened" target="_blank">Open by link</a>
<p data-testid="unasked">waiting</p>
<script>
const query = new URLSearchParams(location.search)
const times = Number(query.get('times') ?? '1')
const opened = []
const open = () => {
  opened.push(window.open('/opened-unasked?app=' + query.get('app') + '&test=' + query.get('test') + '&n=' + opened.length))
  if (opened.length === times) document.querySelector('[data-testid="unasked"]').textContent = opened.length + ' windows'
  else if (query.has('apart')) setTimeout(open)
  else open()
}
if (query.has('unasked')) setTimeout(open, 300)
</script></body></html>`

// How many windows the tests that carry on open with no click. When Retest closed a blocked window as soon as it ran, on
// Linux arm64 4 of 260 windows opened each in a task of its own asked the server for their document, 2 of them among the
// 100 opened as soon as the page was free, and none of 50 opened one after another in one task. At 4 in 260, three
// hundred apart miss it in about one run in a hundred: three rounds of a hundred, each on a page of its own, so each
// round's check is done within the assertion's default time. The fifty together keep many blocked windows waiting at once.
const together = 50
const apart = 100
const rounds = [1, 2, 3]

const tests = `import { expect, test } from 'retest'

for (const app of ['full', 'shell']) {
  test(\`\${app} reads the page\`, { apps: [app] }, async (apps) => {
    const page = apps[app]
    await page.goto(\`/probe?app=\${app}\`)
    await expect(page).toHaveTitle('reported')
    const tab = await page.popup(() => page.getByTestId('tab').click())
    await expect(tab).toHaveTitle('reported')
  })

  test(\`\${app} draws text and controls\`, { apps: [app] }, async (apps) => {
    const page = apps[app]
    await page.goto('/text')
    await expect(page).toHaveScreenshot('text')
  })

  test(\`\${app} opens a window from a click\`, { apps: [app] }, async (apps) => {
    const page = apps[app]
    await page.goto('/opener')
    const popup = await page.popup(() => page.getByTestId('now').click())
    await expect(popup).toHaveTitle('Opened')
  })

  test(\`\${app} opens a window from a timer a click started\`, { apps: [app] }, async (apps) => {
    const page = apps[app]
    await page.goto('/opener')
    const popup = await page.popup(() => page.getByTestId('soon').click())
    await expect(popup).toHaveTitle('Opened')
  })

  test(\`\${app} opens a window from a link with a target\`, { apps: [app] }, async (apps) => {
    const page = apps[app]
    await page.goto('/opener')
    const popup = await page.popup(() => page.getByTestId('link').click())
    await expect(popup).toHaveTitle('Opened')
  })

  test(\`\${app} waits for a window the page opens with no click\`, { apps: [app] }, async (apps) => {
    const page = apps[app]
    await page.popup(() => page.goto(\`/opener?unasked&app=\${app}&test=waits\`))
  })

  test(\`\${app} carries on past windows the page opens with no click, one after another\`, { apps: [app] }, async (apps) => {
    const page = apps[app]
    await page.goto(\`/opener?unasked&app=\${app}&test=together&times=${together}\`)
    await expect(page.getByTestId('unasked')).toHaveText('${together} windows')
  })

  for (const round of ${JSON.stringify(rounds)}) {
    test(\`\${app} carries on past windows the page opens with no click, each in a task of its own, round \${round}\`, { apps: [app] }, async (apps) => {
      const page = apps[app]
      await page.goto(\`/opener?unasked&app=\${app}&test=apart-\${round}&times=${apart}&apart\`)
      await expect(page.getByTestId('unasked')).toHaveText('${apart} windows')
    })
  }
}
`

type Served = { url: string; reports: Map<string, unknown>; headers: Map<string, IncomingHttpHeaders>; asked: string[] }

async function serve(t: TestContext): Promise<Served> {
  const reports = new Map<string, unknown>()
  const headers = new Map<string, IncomingHttpHeaders>()
  const asked: string[] = []
  const opened = '<!doctype html><title>Opened</title><link rel="icon" href="data:,"><p>opened</p>'
  const pages: Record<string, string> = { '/probe': probePage, '/text': textPage, '/opener': opener, '/opened': opened, '/opened-unasked': opened }
  const server = createServer((request, response) => {
    const address = new URL(request.url ?? '/', 'http://localhost')
    if (request.method === 'POST' && address.pathname === '/report') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => (body += chunk))
      request.on('end', () => {
        reports.set(address.searchParams.get('app') ?? '', JSON.parse(body))
        response.end()
      })
      return
    }
    if (address.pathname === '/probe') headers.set(address.searchParams.get('app') ?? '', request.headers)
    asked.push(`${address.pathname}${address.search}`)
    const page = pages[address.pathname]
    response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page ?? '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return { url: `http://127.0.0.1:${address.port}`, reports, headers, asked }
}

async function project(t: TestContext, served: Served): Promise<string> {
  const target = (path: string, headlessShell: boolean) => `chromium({ baseUrl: ${JSON.stringify(served.url)}, executablePath: ${JSON.stringify(path)}, headlessShell: ${headlessShell} })`
  return writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { full: ${target(chrome ?? '', false)}, shell: ${target(shell ?? '', true)} } }`),
    'tests/parity.retest.ts': tests,
  })
}

// Why a run did not pass, beyond what it printed: the run's own failure, and each test that did not pass or whose cleanup
// failed, with why.
function whyNotPassed(run: FinishedRun): string {
  const tests = run.result?.files.flatMap((file) => file.tests) ?? []
  const lines = [run.stderr, run.result?.failure?.message ?? '', ...tests.flatMap((each) => [
    ...(each.status === 'passed' ? [] : [`${each.name}: ${each.status}: ${each.failure?.message ?? ''}`]),
    ...(each.cleanupFailures ?? []).map((failure) => `${each.name}: cleanup: ${failure.message}`),
  ])]
  return lines.filter((line) => line !== '').join('\n')
}

function statusOf(run: FinishedRun, name: string): [string, string | undefined] {
  const found = testNamed(run, name)
  return [found.status, found.failure?.message]
}

function browserLog(run: FinishedRun, app: string): string {
  const logs = join(run.output, 'logs')
  return readdirSync(logs, { recursive: true, encoding: 'utf8' }).filter((path) => path.includes(app) && path.endsWith('.log')).map((path) => readFileSync(join(logs, path), 'utf8')).join('\n')
}

test('a page reads the same languages, user agent, client hints, window, permissions and fonts on the shell as on Chrome', { skip }, async (t) => {
  const served = await serve(t)
  const root = await project(t, served)
  const run = await runProject(t, root, { timeouts: budgets(), args: ['--grep', '/reads the page/'] })
  assert.equal(run.exit.code, 0, whyNotPassed(run))
  assert.deepEqual(resultOf(run).browsers?.map((browser) => browser.product).sort(), ['Chrome', 'HeadlessChrome'], 'the record names each program')
  assert.equal(new Set(resultOf(run).browsers?.map((browser) => browser.version)).size, 1, 'Chrome for Testing and the shell are of one release')
  const [full, shellReading] = [served.reports.get('full'), served.reports.get('shell')]
  assert.ok(full !== undefined && shellReading !== undefined, 'both pages reported')
  assert.deepEqual(shellReading, full)
  assert.deepEqual(served.reports.get('shell-tab'), served.reports.get('full-tab'), 'a window the page opened as a tab reads the same too')
  const recorded = window042[process.platform]
  if (recorded !== undefined) {
    const placed = (reading: unknown) => {
      assert.ok(isRecord(reading))
      return { viewport: reading['viewport'], window: reading['window'], screen: reading['screen'], position: reading['position'] }
    }
    assert.deepEqual(placed(full), recorded.page, 'a page with no viewport reads what Retest 0.4.2 gave it')
    assert.deepEqual(placed(served.reports.get('full-tab')), recorded.tab, 'and so does a window it opened as a tab')
  }
  const sent = (app: string) => {
    const headers = served.headers.get(app) ?? {}
    return { acceptLanguage: headers['accept-language'], userAgent: headers['user-agent'], clientHints: headers['sec-ch-ua'] }
  }
  assert.deepEqual(sent('shell'), sent('full'))
  assert.ok(sent('full').acceptLanguage !== undefined, 'Chrome sends a language')
})

test('the shell draws text and form controls as Chrome does, so Chrome\'s baseline holds for it', { skip }, async (t) => {
  const served = await serve(t)
  const root = await project(t, served)
  const written = await runProject(t, root, { timeouts: budgets(), args: ['--grep', '/full draws/', '--update-screenshots'] })
  assert.equal(written.exit.code, 0, whyNotPassed(written))
  const compared = await runProject(t, root, { timeouts: budgets(), args: ['--grep', '/shell draws/'] })
  assert.deepEqual(statusOf(compared, 'shell draws text and controls'), ['passed', undefined])
})

test('a window the page opens has the same fate on the shell as on Chrome, and one with no click behind it is blocked', { skip }, async (t) => {
  const served = await serve(t)
  const root = await project(t, served)
  const run = await runProject(t, root, { timeouts: budgets(), args: ['--grep', '/window/'] })
  const blocked = 'The page opened a window without a click or a key press behind it, and Chrome blocks such a window for the people who use it, so no page opened.'
  for (const app of ['full', 'shell']) {
    assert.deepEqual(statusOf(run, `${app} opens a window from a click`), ['passed', undefined], app)
    assert.deepEqual(statusOf(run, `${app} opens a window from a timer a click started`), ['passed', undefined], app)
    assert.deepEqual(statusOf(run, `${app} opens a window from a link with a target`), ['passed', undefined], app)
    assert.deepEqual(statusOf(run, `${app} waits for a window the page opens with no click`), ['failed', blocked], app)
    assert.deepEqual(statusOf(run, `${app} carries on past windows the page opens with no click, one after another`), ['passed', undefined], app)
    for (const round of rounds) assert.deepEqual(statusOf(run, `${app} carries on past windows the page opens with no click, each in a task of its own, round ${round}`), ['passed', undefined], app)
    assert.match(browserLog(run, app), /the page opened http:\/\/127\.0\.0\.1:\d+\/opened-unasked without a click or a key press behind it; Chrome blocks such a window/, `${app}: the browser's log records the window`)
  }
  assert.match(browserLog(run, 'shell'), /so Retest closed it in the headless shell before it ran/)
  assert.deepEqual(served.asked.filter((path) => path.startsWith('/opened-unasked')), [], 'a blocked window asks for nothing, on Chrome and on the shell')
  assert.doesNotMatch(browserLog(run, 'shell'), /Retest could not (hold|refuse|let|close)|asked for no document within/, 'Retest held, refused and closed every blocked window in time')
})
