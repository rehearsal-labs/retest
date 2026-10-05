import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firefoxPlatformProblem } from '../../src/browser/firefox/executable.ts'
import { firefoxRoute } from '../../src/browser/firefox/route.ts'

test('the Firefox route is spawn unless the machine names Launch Services, which only macOS has', () => {
  assert.deepEqual(firefoxRoute({}, 'darwin'), { ok: true, route: 'spawn' })
  assert.deepEqual(firefoxRoute({ RETEST_FIREFOX_ROUTE: '' }, 'darwin'), { ok: true, route: 'spawn' })
  assert.deepEqual(firefoxRoute({ RETEST_FIREFOX_ROUTE: 'launch-services' }, 'darwin'), { ok: true, route: 'launch-services' })
  const linux = firefoxRoute({ RETEST_FIREFOX_ROUTE: 'launch-services' }, 'linux')
  assert.ok(!linux.ok)
  assert.match(linux.message, /needs macOS/)
  const unknown = firefoxRoute({ RETEST_FIREFOX_ROUTE: 'open' }, 'darwin')
  assert.ok(!unknown.ok)
  assert.equal(unknown.message, 'RETEST_FIREFOX_ROUTE must be spawn or launch-services, received "open".')
})

test('Retest runs Firefox on macOS on Apple silicon only, and names any other machine', () => {
  assert.equal(firefoxPlatformProblem('darwin', 'arm64'), undefined)
  assert.equal(firefoxPlatformProblem('linux', 'x64'), 'Retest runs Firefox on macOS on Apple silicon, and this machine is linux x64.')
  assert.equal(firefoxPlatformProblem('darwin', 'x64'), 'Retest runs Firefox on macOS on Apple silicon, and this machine is darwin x64.')
})
