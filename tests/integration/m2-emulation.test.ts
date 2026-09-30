import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emulationFor } from '../../src/config/devices.ts'
import { browserPath, openApp } from './browser-harness.ts'
import {
  assertSucceeded,
  budgets,
  configSource,
  eventsOf,
  runCli,
  runProgram,
  runProject,
  secondBrowserPath,
  testNamed,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 6: emulation sets the screen, the user agent and touch, tap() works, and every report says
// the target is emulated. Emulation is desktop Chrome pretending, never a real device.

async function chromeVersion(): Promise<string> {
  const printed = await runProgram(browserPath(), ['--version'], process.cwd())
  assertSucceeded(printed, 'chrome --version')
  const version = /(\d+\.\d+\.\d+\.\d+)/.exec(printed.stdout)?.[1]
  assert.ok(version !== undefined, `a version in ${printed.stdout}`)
  return version
}

function deviceTests(pixelUserAgent: string): string {
  return `import { expect, test } from '@rehearsal-labs/retest'

test('the phone has the screen, the user agent and the touch screen of a Pixel 9', { apps: ['phone'] }, async ({ phone }) => {
  await phone.goto('/device')
  await expect(phone.getByTestId('width')).toHaveText('412')
  await expect(phone.getByTestId('pixel-ratio')).toHaveText('2.625')
  await expect(phone.getByTestId('touch')).toHaveText('true')
  await expect(phone.getByTestId('user-agent')).toHaveText(${JSON.stringify(pixelUserAgent)})
  await expect(phone.getByTestId('user-agent-header')).toHaveText(${JSON.stringify(pixelUserAgent)})
  await expect(phone.getByTestId('client-hints')).toHaveText('')
  await phone.getByRole('button', { name: 'Touch me' }).tap()
  await expect(phone.getByTestId('touch-events')).toHaveText('touchstart touchend click:touch')
})

test('a click on a touch screen is sent as a tap', { apps: ['phone'] }, async ({ phone }) => {
  await phone.goto('/device')
  await phone.getByTestId('touch-target').click()
  await expect(phone.getByTestId('touch-events')).toHaveText('touchstart touchend click:touch')
})

test('a screen of the config own keeps the browser user agent', { apps: ['tablet'] }, async ({ tablet }) => {
  await tablet.goto('/device')
  await expect(tablet.getByTestId('width')).toHaveText('800')
  await expect(tablet.getByTestId('pixel-ratio')).toHaveText('2')
  await expect(tablet.getByTestId('touch')).toHaveText('true')
  await tablet.getByTestId('touch-target').tap()
  await expect(tablet.getByTestId('touch-events')).toHaveText('touchstart touchend click:touch')
})

test('the desktop has no touch screen, and its click is a mouse click', async ({ page }) => {
  await page.goto('/device')
  await expect(page.getByTestId('touch')).toHaveText('false')
  await page.getByTestId('touch-target').click()
  await expect(page.getByTestId('touch-events')).toHaveText('click:mouse')
})
`
}

const failingTest = `import { expect, test } from '@rehearsal-labs/retest'

test('fails on the phone', { apps: ['phone'] }, async ({ phone }) => {
  await phone.goto('/device')
  await expect(phone.getByTestId('width')).toHaveText('1280')
})
`

test('emulation applies the screen, user agent and touch, tap works, and every report marks the target emulated', async (t) => {
  const app = await openApp(t)
  const version = await chromeVersion()
  const pixel = emulationFor('Pixel 9', version)
  const baseUrl = JSON.stringify(app.url)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: {
    desktop: chrome({ baseUrl: ${baseUrl} }),
    phone: chrome({ baseUrl: ${baseUrl}, emulate: 'Pixel 9' }),
    tablet: chromium({
      baseUrl: ${baseUrl},
      executablePath: ${JSON.stringify(secondBrowserPath())},
      emulate: { viewport: { width: 800, height: 1000 }, deviceScaleFactor: 2, touch: true },
    }),
  },
  defaultApp: 'desktop',
}`),
    'tests/devices.retest.ts': deviceTests(pixel.userAgent ?? ''),
    'tests/fails.retest.ts': failingTest,
  })

  const run = await runProject(t, root, { files: ['tests/devices.retest.ts'], reporter: 'human', args: ['--no-agent'] })
  assert.equal(run.exit.code, 0, `${run.stdout}\n${run.stderr}`)

  const browsers = eventsOf(run.events, 'browser.started')
  const phone = browsers.find((event) => event.app === 'phone')
  assert.deepEqual(phone?.target, { name: 'chrome', device: 'Pixel 9', emulation: pixel })
  const tablet = browsers.find((event) => event.app === 'tablet')
  assert.deepEqual(tablet?.target, {
    name: 'chromium',
    emulation: { viewport: { width: 800, height: 1000 }, deviceScaleFactor: 2, touch: true, isMobile: false },
  })
  assert.deepEqual(browsers.find((event) => event.app === 'desktop')?.target, { name: 'chrome' })

  const clicked = testNamed(run, 'a click on a touch screen is sent as a tap')
  const commands = eventsOf(run.events, 'action.completed').filter((event) => event.testId === clicked.testId).map((event) => event.command)
  assert.deepEqual(commands, ['goto', 'tap'], 'the click was sent and recorded as a tap')
  const desktop = testNamed(run, 'the desktop has no touch screen, and its click is a mouse click')
  assert.ok(eventsOf(run.events, 'action.completed').some((event) => event.testId === desktop.testId && event.command === 'click'))

  assert.match(run.stdout, /phone=chrome \(emulated\)/)
  assert.match(run.stdout, /tablet=chromium \(emulated\)/)
  assert.match(run.stdout, /^ {2}phone=chrome +Chrome \S+ as Pixel 9 · emulated/m)
  assert.match(run.stdout, /^ {2}tablet=chromium +Chrome \S+ · emulated/m)
  assert.doesNotMatch(run.stdout, /desktop=chrome \(emulated\)/)

  const failed = await runProject(t, root, { files: ['tests/fails.retest.ts'], reporter: 'agent', timeouts: budgets({ assertion: 500 }) })
  assert.equal(failed.exit.code, 1, failed.stderr)
  assert.match(failed.stdout, /phone=chrome \(emulated\)/)

  const inspected = await runCli(t, ['inspect', failed.output], { cwd: root })
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  assert.match(inspected.stdout, /emulated/)
  const inspectedJson = await runCli(t, ['inspect', failed.output, '--json'], { cwd: root })
  assert.match(inspectedJson.stdout, /"device": "Pixel 9"/)
})
