import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { errorMessage } from '../../src/protocol/failures.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { browserPath } from '../support/test-browser.ts'

// A close asks Chrome to quit and ends its recorded processes at once. While Chrome quits, macOS `ps` can no longer
// read a quitting process's arguments and prints its short name in parentheses instead, which Retest once read as a
// different process and refused to end. Closing at once after launch, as `retest doctor` does, while Chrome is still
// starting helpers, was refused in 8 of 10 closes; closing after a page opened, as a run does, more rarely.
const closes = 10
const setupMs = 10_000
const closeMs = 5000

const chromeForTesting = join(homedir(), 'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')

/** Chrome for Testing: `RETEST_TEST_SECOND_BROWSER`, or where it was unpacked on the machine these checks were written on. */
function chromeForTestingPath(): string {
  const configured = process.env['RETEST_TEST_SECOND_BROWSER']
  if (configured) return configured
  if (existsSync(chromeForTesting)) return chromeForTesting
  throw new Error(`No Chrome for Testing to test with: set RETEST_TEST_SECOND_BROWSER, or unpack Chrome for Testing at ${chromeForTesting}`)
}

/**
 * Launches the browser and closes it, `closes` times: at once after launch, as `retest doctor` does, and after opening
 * a page, as a run does, in turn. Returns what each close refused.
 */
async function closeRepeatedly(executablePath: string): Promise<string[]> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-browser-ownership-'))
  const failures: string[] = []
  try {
    for (let launch = 1; launch <= closes; launch++) {
      const browser = await launchBrowser({ executablePath, logFile: join(folder, `browser-${launch}.log`), headless: true })
      try {
        if (launch % 2 === 0) await browser.newPage({}, setupMs)
      } finally {
        await browser.close(closeMs).catch((error: unknown) => { failures.push(`close ${launch}: ${errorMessage(error)}`) })
      }
      if (signalGroup(browser.pid, 0)) failures.push(`close ${launch}: process group ${browser.pid} was still there`)
    }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
  return failures
}

test('Chrome for Testing closes ten times in a row with every recorded process ended and none refused', async () => {
  assert.deepEqual(await closeRepeatedly(chromeForTestingPath()), [])
})

test('the test browser closes ten times in a row with every recorded process ended and none refused', async () => {
  assert.deepEqual(await closeRepeatedly(browserPath()), [])
})
