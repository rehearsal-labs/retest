import type { ConsoleCapture, DiagnosticScope, DiagnosticsSummary, KindScope, NetworkCapture } from '../protocol/diagnostics.ts'
import type { TestResult } from '../protocol/result.ts'
import { join } from 'node:path'
import { capturedCounts } from '../protocol/diagnostics.ts'
import { diagnosticsFolder } from '../protocol/run-folder.ts'

// How reports speak of diagnostics: counts, states and where the artifact is, never what a message or an address
// says. `inspect --test` is where the records themselves are shown.

/** One line of a failure card, as `label  value`. */
export type DiagnosticsLine = { label: string; value: string }

// A state's reason comes from Retest, and sometimes quotes the browser; a report shows this much of it.
const reasonLength = 160

/**
 * Card lines for each session of a test: each kind's counts or state, a partial or unavailable capture with its reason,
 * and the artifact; then, beside the artifact, what the capture covers.
 *
 * @example diagnosticsCardLines(test.diagnostics ?? [], '.retest/runs/latest')[0]?.value // 'console 3 entries, 1 error · network 4 requests, 1 HTTP error · .retest/runs/latest/diagnostics/…'
 */
export function diagnosticsCardLines(summaries: readonly DiagnosticsSummary[], runFolder: string): DiagnosticsLine[] {
  return summaries.flatMap((summary) => {
    const where = summary.path === undefined ? [] : [join(runFolder, summary.path)]
    const app = summary.app === undefined ? '' : `${summary.app}: `
    const parts = bothDisabled(summary) ? ['capture disabled'] : [describeConsole(summary.console, summary.scope?.source === 'owned_app' ? 'app log' : 'console'), describeNetwork(summary.network)]
    const line = { label: 'Diagnostics', value: `${app}${[...parts, ...where].join(' · ')}` }
    return summary.scope === undefined || summary.path === undefined ? [line] : [line, { label: 'Scope', value: `${app}${describeScope(summary.scope)}` }]
  })
}

/**
 * What a capture covers, as reports say it.
 *
 * @example describeScope(chromiumScope) // 'console covers top level document, same process frames, dedicated workers; network covers top level document, same process frames'
 */
export function describeScope(scope: DiagnosticScope): string {
  const covers = `${scope.source === 'owned_app' ? 'app log' : 'console'} covers ${coveredAreas(scope.console)}; network covers ${coveredAreas(scope.network)}`
  return scope.reason === undefined ? covers : `${covers}. ${scope.reason}`
}

function coveredAreas(scope: KindScope): string {
  return scope.covered.length === 0 ? 'nothing' : scope.covered.map((area) => area.replaceAll('_', ' ')).join(', ')
}

/**
 * The run's diagnostics in a few counts, across every test: what the pages did that is worth a look (runtime errors,
 * console errors, HTTP error responses, failed requests), the sessions whose capture was partial or unavailable, and
 * the records cut to their limit. Undefined when there is nothing to tell, so a run whose every capture is complete and
 * quiet prints nothing here, and one whose driver collects nothing says so.
 *
 * @example diagnosticsTotals(tests) // ['1 runtime error', '2 HTTP errors', '1 partial capture']
 */
export function diagnosticsTotals(tests: readonly TestResult[]): string[] | undefined {
  const totals = { runtimeErrors: 0, errors: 0, httpErrors: 0, failed: 0, partial: 0, unavailable: 0, cut: 0 }
  for (const summary of tests.flatMap((test) => test.diagnostics ?? [])) {
    // A session counts once for each state either of its kinds is in.
    const states = new Set([summary.console.state, summary.network.state])
    if (states.has('partial')) totals.partial += 1
    if (states.has('unavailable')) totals.unavailable += 1
    const consoleCounts = capturedCounts(summary.console)
    const networkCounts = capturedCounts(summary.network)
    totals.runtimeErrors += consoleCounts?.runtimeErrors ?? 0
    totals.errors += consoleCounts?.errors ?? 0
    totals.httpErrors += networkCounts?.httpErrors ?? 0
    totals.failed += networkCounts?.transportFailures ?? 0
    totals.cut += (consoleCounts?.truncated ?? 0) + (networkCounts?.truncated ?? 0)
  }
  const parts = [
    counted(totals.runtimeErrors, 'runtime error', 'runtime errors'),
    counted(totals.errors, 'console error', 'console errors'),
    counted(totals.httpErrors, 'HTTP error', 'HTTP errors'),
    counted(totals.failed, 'failed request', 'failed requests'),
    counted(totals.partial, 'partial capture', 'partial captures'),
    counted(totals.unavailable, 'unavailable capture', 'unavailable captures'),
    counted(totals.cut, 'record cut', 'records cut'),
  ].flat()
  return parts.length === 0 ? undefined : parts
}

/**
 * Where a run's diagnostics artifacts are, as a report names the folder.
 *
 * @example diagnosticsLocation('.retest/runs/latest') // '.retest/runs/latest/diagnostics'
 */
export function diagnosticsLocation(runFolder: string): string {
  return join(runFolder, diagnosticsFolder)
}

/**
 * A console capture as a report says it.
 *
 * @example describeConsole({ state: 'complete', entries: 0, errors: 0, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: 0 }) // 'console empty'
 */
export function describeConsole(capture: ConsoleCapture, name = 'console'): string {
  const counts = capturedCounts(capture)
  if (counts === undefined) return stateOnly(name, capture)
  const parts = [
    `${counts.entries} ${counts.entries === 1 ? 'entry' : 'entries'}`,
    ...counted(counts.errors, 'error', 'errors'),
    ...counted(counts.warnings, 'warning', 'warnings'),
    ...counted(counts.runtimeErrors, 'runtime error', 'runtime errors'),
    ...counted(counts.handledLater, 'handled later', 'handled later'),
    ...counted(counts.truncated, 'cut', 'cut'),
  ]
  const body = counts.entries === 0 && counts.runtimeErrors === 0 ? 'empty' : parts.join(', ')
  return withState(name, body, capture)
}

/**
 * A network capture as a report says it.
 *
 * @example describeNetwork({ state: 'complete', requests: 2, httpErrors: 1, transportFailures: 0, canceled: 0, pending: 0, outOfScope: 0, dropped: 0, truncated: 0, bytes: 900 }) // 'network 2 requests, 1 HTTP error'
 */
export function describeNetwork(capture: NetworkCapture): string {
  const counts = capturedCounts(capture)
  if (counts === undefined) return stateOnly('network', capture)
  const parts = [
    `${counts.requests} ${counts.requests === 1 ? 'request' : 'requests'}`,
    ...counted(counts.httpErrors, 'HTTP error', 'HTTP errors'),
    ...counted(counts.transportFailures, 'failed', 'failed'),
    ...counted(counts.canceled, 'cancelled', 'cancelled'),
    ...counted(counts.pending, 'pending', 'pending'),
    ...counted(counts.outOfScope, 'out of scope', 'out of scope'),
  ]
  return withState('network', counts.requests === 0 ? 'empty' : parts.join(', '), capture)
}

function withState(kind: string, body: string, capture: ConsoleCapture | NetworkCapture): string {
  if (capture.state !== 'partial') return `${kind} ${body}`
  const dropped = 'dropped' in capture && capture.dropped > 0 ? `, ${capture.dropped} dropped` : ''
  return `${kind} partial (${body}${dropped}): ${shortReason(capture.reason)}`
}

function stateOnly(kind: string, capture: ConsoleCapture | NetworkCapture): string {
  if (capture.state === 'unavailable') return `${kind} unavailable: ${shortReason(capture.reason)}`
  return `${kind} ${capture.state}`
}

function bothDisabled(summary: DiagnosticsSummary): boolean {
  return summary.console.state === 'disabled' && summary.network.state === 'disabled'
}

function shortReason(reason: string): string {
  return reason.length > reasonLength ? `${reason.slice(0, reasonLength)}…` : reason
}

function counted(count: number, one: string, many: string): string[] {
  return count === 0 ? [] : [`${count} ${count === 1 ? one : many}`]
}
