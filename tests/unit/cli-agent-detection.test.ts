import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { agentVariables, isCodingAgent } from '../../src/cli/agent-detection.ts'

describe('isCodingAgent', () => {
  test('includes the variables the brief names', () => {
    for (const name of ['CLAUDECODE', 'CODEX_THREAD_ID', 'AGENT', 'AI_AGENT'])
      assert.ok(agentVariables.includes(name), name)
  })

  test('detects any agent variable that is set', () => {
    for (const name of agentVariables) {
      assert.equal(isCodingAgent({ [name]: '1' }), true, name)
      assert.equal(isCodingAgent({ [name]: 'thread-7f3a' }), true, name)
    }
  })

  test('ignores variables that are unset, empty or switched off', () => {
    assert.equal(isCodingAgent({}), false)
    assert.equal(isCodingAgent({ PATH: '/usr/bin', CI: 'true' }), false)
    for (const setting of ['', '0', 'false', 'FALSE', ' 0 '])
      assert.equal(isCodingAgent({ CLAUDECODE: setting }), false, setting)
  })
})
