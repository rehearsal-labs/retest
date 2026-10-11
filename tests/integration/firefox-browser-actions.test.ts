import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { launch, openApp, openPage, goto, select, observe } from './browser-harness.ts'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'

// The fixed browser-actions suite, the action cases against the driver, run unchanged on Firefox: the harness
// launches and configures the browser through tests/integration/engines.ts, and every assertion is the Chromium
// suite's own.
const unsupported = firefoxPlatformProblem()
if (unsupported === undefined) {
  process.env['RETEST_TEST_ENGINE'] = 'firefox'
  await import('./browser-actions.test.ts')
  test('each Firefox selection clears incremental search with a trusted Escape release before its requested character', async (t) => {
    const original = BidiClient.prototype.send
    const keys: string[] = []
    t.mock.method(BidiClient.prototype, 'send', function (this: BidiClient, ...args: Parameters<BidiClient['send']>): Promise<unknown> {
      if (args[0] === 'input.performActions' && isRecord(args[1]) && Array.isArray(args[1]['actions'])) {
        for (const source of args[1]['actions']) {
          if (!isRecord(source) || source['type'] !== 'key' || !Array.isArray(source['actions'])) continue
          for (const action of source['actions']) {
            if (isRecord(action) && action['type'] === 'keyUp' && typeof action['value'] === 'string') keys.push(action['value'])
          }
        }
      }
      return original.apply(this, args)
    })
    const app = await openApp(t)
    const browser = await launch(t)
    const page = await openPage(t, browser, app.url)
    assert.ok((await goto(page, '/actions/choices')).ok)
    for (const country of ['Canada', 'Mexico', 'Canada']) assert.ok((await select(page, 'country', country)).ok)
    assert.equal((await observe(page, 'country-shown')).text, 'ca')
    assert.deepEqual(keys, ['\uE00C', 'c', '\uE00C', 'm', '\uE00C', 'c', 'a'])
  })
} else {
  test('the browser-actions suite on Firefox', (t) => t.skip(unsupported))
}
