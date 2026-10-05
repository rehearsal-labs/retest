import type { SessionIdentity } from '../../src/browser/contract.ts'
import type { DiagnosticSink } from '../../src/diagnostics/observations.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { firefoxConsoleUnavailable, firefoxScope } from '../../src/diagnostics/firefox-collector.ts'
import { defaultDiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { Redactor } from '../../src/runner/redactor.ts'

// A Firefox capture through the attempt that owns it: the network kind is captured as usual, and the console kind is
// unavailable with the collector's reason, so a strict console rule cannot pass on records that were never captured.

const testId = 'firefox.retest.ts > captures the network'
const attemptId = 'k3v9q0x2mb'
const time = '2026-10-05T12:00:00.000Z'

function session(): SessionIdentity {
  return { sessionId: `${attemptId}:web`, owner: { runId: 'run', testId, attemptId, app: 'web' }, runtime: { kind: 'web', engine: 'firefox', product: 'Firefox', version: '133.0.3', executablePath: '/firefox', processIds: [1] } }
}

test('a Firefox capture is complete for the network and unavailable for the console, with the reason, and a strict console rule cannot judge it', async () => {
  let heard: DiagnosticSink | undefined
  const written = new Map<string, string>()
  const diagnostics = new AttemptDiagnostics({
    policy: { ...defaultDiagnosticsPolicy, strict: { runtimeErrors: true, consoleErrors: true, transportFailures: false, httpErrors: false, allow: [] } },
    redactor: new Redactor(),
    writeArtifact: (path, bytes) => void written.set(path, Buffer.from(bytes).toString('utf8')),
    emit: () => {},
    testId,
    attemptId,
    variant: { web: 'firefox' },
    named: true,
    clock: () => Date.parse(time),
  })
  const page = {
    collectDiagnostics: async (sink: DiagnosticSink) => {
      heard = sink
      return { scope: firefoxScope, unavailable: { console: firefoxConsoleUnavailable }, stop: () => {} }
    },
  }
  await diagnostics.start([{ app: 'web', page, session: session() }], 1000)
  assert.ok(heard !== undefined)
  heard.observe({ kind: 'request', key: 'r#1', method: 'GET', url: 'http://127.0.0.1/missing', frame: 'main', time: 1 })
  heard.observe({ kind: 'response', key: 'r#1', status: 404, time: 2 })
  heard.observe({ kind: 'finished', key: 'r#1', time: 3 })
  const finished = diagnostics.finish('attempt_ended')
  const [summary] = finished.summaries
  assert.deepEqual(summary?.console, { state: 'unavailable', reason: firefoxConsoleUnavailable })
  assert.equal(summary?.network.state, 'complete')
  assert.equal(finished.failure?.class, 'reporting_failed', "the policy's own class for a capture it could not judge")
  assert.match(finished.failure?.message ?? '', /could not judge the test/)
  assert.match(finished.failure?.message ?? '', /console/)
  const artifact = [...written.values()].join('')
  assert.match(artifact, /"type":"network\.response"/)
  assert.match(artifact, /"console":\{"state":"unavailable"/, "the artifact's end marker says the console was unavailable")
})
