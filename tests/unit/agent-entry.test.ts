import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'

// The agent session API as a host imports it: through the package's `./agent` subpath, by the package's own name, as
// a program that depends on Retest would, and not by a path into this checkout.

const root = new URL('../../', import.meta.url)

describe('the agent subpath', () => {
  test('names the source, the types and the build, in that order, as the other subpaths do', () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    const exports = isPlainObject(manifest) ? manifest['exports'] : undefined
    assert.ok(isPlainObject(exports))
    const conditions = exports['./agent']
    assert.ok(isPlainObject(conditions))
    assert.deepEqual(Object.entries(conditions), [
      ['retest-source', './src/agent/index.ts'],
      ['types', './dist/agent/index.d.ts'],
      ['default', './dist/agent/index.js'],
    ])
    assert.ok(existsSync(new URL('src/agent/index.ts', root)))
  })

  test('imports by the package name and opens a host', async () => {
    const agent = await import('@rehearsal-labs/retest/agent')
    assert.equal(typeof agent.AgentHost, 'function')
    assert.equal(typeof agent.AgentSession, 'function')
    assert.equal(agent.defaultAgentTimeouts.lease, 60_000)
    const host = new agent.AgentHost({ targets: { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } }, budget: new SessionBudget({ perOwner: 1, host: 1 }), logFolder: '/tmp/retest-agent-unit-logs' })
    assert.deepEqual(await host.close(), { ok: true })
    assert.throws(() => new agent.AgentHost({ targets: {}, budget: new SessionBudget({ perOwner: 1, host: 1 }), logFolder: 'relative' }), agent.AgentHostError)
  })
})
