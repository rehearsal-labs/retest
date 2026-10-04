import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeResetPolicy, iosSimulatorResetPolicy, macosResetPolicy, resetPolicyFor } from '../../src/native/reset-policy.ts'

test('an iOS simulator runtime resets app data and the keychain by starting on a simulator of its own', () => {
  assert.equal(resetPolicyFor('ios-simulator'), iosSimulatorResetPolicy)
  assert.deepEqual(iosSimulatorResetPolicy.contract, { appData: 'reset', keychain: 'reset' })
  assert.match(iosSimulatorResetPolicy.boundary, /creates a simulator .* deletes it/)
  assert.ok(iosSimulatorResetPolicy.notIsolated.some((item) => /backend/.test(item.state)), 'the backend is named as not isolated')
  assert.ok(iosSimulatorResetPolicy.leftToTheApp.some((item) => /relaunch keeps/i.test(item.how)), 'a relaunch within one runtime keeps app data')
})

test('a macOS app keeps its data across a relaunch, and the policy says what it leaves and what it does not isolate', () => {
  assert.equal(resetPolicyFor('macos'), macosResetPolicy)
  assert.deepEqual(macosResetPolicy.contract, { appData: 'kept', keychain: 'kept' })
  const states = [...macosResetPolicy.leftToTheApp, ...macosResetPolicy.notIsolated].map((item) => item.state).join('\n')
  for (const kept of [/defaults/, /Application Support/, /Keychain/, /Saved Application State/, /Recent Items/, /TCC/, /backend/]) assert.match(states, kept)
  assert.ok(macosResetPolicy.cleared.every((item) => !/defaults|keychain/i.test(item.state)), 'Retest claims to clear none of the app data')
})

test('a policy reads in words, one line per item', () => {
  const words = describeResetPolicy(macosResetPolicy)
  assert.match(words, /^Boundary: /)
  assert.match(words, /App data kept, keychain kept, as the session contract states it\.$/)
  assert.equal(words.split('\n').filter((line) => line.startsWith('  - ')).length, macosResetPolicy.cleared.length + macosResetPolicy.leftToTheApp.length + macosResetPolicy.notIsolated.length)
})

test('no policy names a plan phase, and the simulator\'s pasteboard is not claimed reset', () => {
  for (const policy of [iosSimulatorResetPolicy, macosResetPolicy]) assert.doesNotMatch(describeResetPolicy(policy), /Phase \d/)
  assert.ok(iosSimulatorResetPolicy.cleared.every((item) => !/pasteboard/i.test(item.state)))
  assert.ok(iosSimulatorResetPolicy.notIsolated.some((item) => /pasteboard/i.test(item.state)))
})
