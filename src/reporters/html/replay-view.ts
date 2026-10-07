import type { ExecutionRecord, StartingState } from '../../protocol/execution.ts'
import type { TestResult } from '../../protocol/result.ts'
import type { Markup } from './markup.ts'
import { describeCleanup, describePreparation, formatDuration } from '../format.ts'
import { html } from './markup.ts'

/**
 * What a caller needs to replay a test and to tell two attempts apart: how the attempt ended, the bundle it ran with
 * every module's hash, its configuration and the hash of it, the runtime, the session owner and the app builds the host
 * named, the requirement with each check's id and hash, where each app started, what could not be recorded, and the
 * host's preparation and cleanup of it. Absent for a test that never started.
 *
 * @example replayView(test)
 */
export function replayView(test: TestResult): Markup | undefined {
  const { execution, ending } = test
  const preparations = test.preparations ?? []
  const cleanups = test.cleanups ?? []
  if (execution === undefined && ending === undefined && preparations.length === 0 && cleanups.length === 0) return undefined
  const rows: [string, string][] = []
  if (ending !== undefined) {
    const notRun = ending.notRun === undefined || ending.notRun.length === 0 ? '' : `; required checks not run: ${ending.notRun.join(', ')}`
    rows.push(['Ending', `${ending.kind.replaceAll('_', ' ')}${ending.checkId === undefined ? '' : `, check ${ending.checkId}`}${notRun}`])
  }
  if (execution !== undefined) rows.push(...executionRows(execution))
  for (const preparation of preparations) rows.push(['Preparation', `${describePreparation(preparation)}${preparationFacts(preparation)}, ${formatDuration(preparation.durationMs)}`])
  for (const cleanup of cleanups) rows.push(['Cleanup', `${describeCleanup(cleanup)}, ${formatDuration(cleanup.durationMs)}`])
  const modules = execution?.bundle === undefined || execution.bundle.modules.length === 0 ? undefined : modulesView(execution)
  return html`<dl class="check-lines">${rows.map(([label, value]) => html`<dt>${label}</dt><dd class="words">${value}</dd>`)}</dl>${modules}`
}

function executionRows(execution: ExecutionRecord): [string, string][] {
  const { configuration, runtime, requirement } = execution
  const settings = configuration.settings
  const apps = Object.entries(settings.apps).map(([app, target]) => `${app}=${target.target} (${[target.kind, ...(target.browser === undefined ? [] : [target.browser]), ...(target.headless === true ? ['headless'] : [])].join(', ')})`)
  const rows: [string, string][] = [
    ['Bundle', execution.bundle === undefined ? 'not recorded' : `sha256 ${execution.bundle.sha256}, ${execution.bundle.modules.length} modules`],
    ['Configuration', `sha256 ${configuration.sha256}; ${apps.join(', ')}`],
    ['Diagnostics', settings.diagnostics.capture ? 'captured' : 'not captured'],
    ['Runtime', `Retest ${runtime.retest}, Node ${runtime.node} on ${runtime.platform}`],
  ]
  if (settings.locks.length > 0) rows.push(['Locks', settings.locks.join(', ')])
  if (settings.environment !== undefined) rows.push(['Environment', `names given: ${settings.environment.join(', ') || 'none'}`])
  for (const judge of settings.evaluation?.judges ?? []) rows.push(['Judge', `${judge.name}: ${judge.adapter} adapter${judge.moduleSha256 === undefined ? '' : `, sha256 ${judge.moduleSha256}`}${judge.packageVersion === undefined ? '' : `, version ${judge.packageVersion}`}${judge.codeUnavailable === true ? ', code not readable' : ''}, options sha256 ${judge.optionsSha256}`])
  if (settings.playwright === true) rows.push(['Playwright', 'ran as a Playwright test file'])
  for (const secret of execution.secretReferences ?? []) rows.push(['Secret', `${secret.name} from ${secret.source}${secret.variable === undefined ? '' : ` ${secret.variable}`}, never its value`])
  if (execution.owner !== undefined) rows.push(['Session owner', execution.owner])
  for (const [app, build] of Object.entries(execution.appBuilds ?? {})) rows.push(['App build', `${app}: ${build}`])
  if (requirement !== undefined) {
    rows.push(['Requirement', `version ${requirement.version}, sha256 ${requirement.sha256}`])
    for (const check of requirement.checks) rows.push(['Required check', `${check.id}, ${check.kind}, sha256 ${check.sha256}`])
  }
  for (const state of execution.startingState) rows.push(['Started from', describeStartingState(state)])
  if (execution.unavailable !== undefined && execution.unavailable.length > 0) rows.push(['Not recorded', execution.unavailable.join(', ')])
  return rows
}

function describeStartingState(state: StartingState): string {
  const storage = state.browserStorage === 'saved' && state.state !== undefined ? `saved state ${state.state}` : `${state.browserStorage} browser storage`
  const native = state.native === undefined ? '' : `; app data ${state.native.appData}, keychain ${state.native.keychain}, ${state.native.boundary}${state.native.notIsolated.length === 0 ? '' : `, not isolated: ${state.native.notIsolated.join(', ')}`}`
  return `${state.app}: ${storage}, backend data ${state.backendData}${native}`
}

function preparationFacts(preparation: NonNullable<TestResult['preparations']>[number]): string {
  const receipt = preparation.receipt === undefined ? '' : `, receipt ${preparation.receipt}`
  const metadata = Object.entries(preparation.metadata ?? {}).map(([key, value]) => `${key} ${String(value)}`)
  return `${receipt}${metadata.length === 0 ? '' : `, ${metadata.join(', ')}`}`
}

function modulesView(execution: ExecutionRecord): Markup {
  const modules = execution.bundle?.modules ?? []
  const rows = modules.map((module) => html`<tr><td class="words"><code>${module.path}</code></td><td class="words muted"><code>${module.sha256}</code></td></tr>`)
  return html`<details class="part"><summary>Modules of the bundle (${modules.length})</summary><div class="table-wrap"><table><thead><tr><th scope="col">Module</th><th scope="col">sha256</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
}
