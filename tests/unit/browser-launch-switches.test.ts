import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromiumArguments } from '../../src/browser/launch.ts'

// The switches that keep Chrome from doing work a test never uses. What they save was measured on a real browser, not
// here: this file says only that the command line carries them.

test("the browser runs Chrome's default features, without the experiments of Chromium's testing config", () => {
  for (const headless of [true, false]) {
    const args = chromiumArguments('/tmp/retest-profile-3', headless)
    assert.ok(args.includes('--disable-field-trial-config'), `headless ${headless}`)
    assert.equal(args.at(-1), 'about:blank', 'the start page still comes last')
  }
})

test('the browser starts no spare renderer process ahead of a page that may never need it', () => {
  for (const headless of [true, false]) {
    const args = chromiumArguments('/tmp/retest-profile-4', headless)
    assert.ok(args.includes('--disable-features=SpareRendererForSitePerProcess'), `headless ${headless}`)
    // Chrome reads only the last --disable-features it is given, so a second one would undo the first.
    assert.equal(args.filter((flag) => flag.startsWith('--disable-features=')).length, 1)
  }
})

test('the sandbox stays on: no switch turns it off', () => {
  const args = chromiumArguments('/tmp/retest-profile-5', true)
  for (const flag of ['--no-sandbox', '--disable-setuid-sandbox', '--no-zygote', '--single-process']) assert.equal(args.includes(flag), false, flag)
})
