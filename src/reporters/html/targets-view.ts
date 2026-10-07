import type { NativeExecutionRecord } from '../../protocol/execution.ts'
import type { TestResult } from '../../protocol/result.ts'
import type { EventOfType } from '../run-record.ts'
import type { Markup } from './markup.ts'
import type { ReportContext } from './report-context.ts'
import { describeBrowser, describeProxy, describeVariant } from '../targets.ts'
import { html } from './markup.ts'

type Browser = EventOfType<'browser.started'>

/**
 * What a test ran on: its targets, each session's engine, product, version and build as the browser reported them,
 * with its executable, emulation and proxy, each native app's own identity and the executor that drove it, and the
 * runtime Retest ran on. A fact the run did not record is said to be unrecorded, never filled in.
 *
 * @example targetsView(test, context)
 */
export function targetsView(test: TestResult, context: ReportContext): Markup {
  const variant = describeVariant(test.variant, context.targets)
  const sessions = test.execution?.sessions ?? []
  const apps = sessions.length > 0 ? sessions.map((session) => session.app) : Object.keys(test.variant ?? { page: '' })
  const rows = apps.map((app) => {
    const session = sessions.find((each) => each.app === app)
    const native = context.record.natives.find((each) => each.attemptId === test.attemptId && each.app === app)
    if (native !== undefined) return nativeRow(app, native)
    const browser = browserFor(app, test, context)
    const product = browser === undefined ? (session === undefined ? 'not recorded' : `${session.product} ${session.version}`) : describeBrowser(browser)
    const engine = browser?.engine ?? session?.engine ?? 'not recorded'
    const notes = [
      ...(session?.resource === undefined ? [] : [`takes a ${session.resource.replaceAll('-', ' ')}`]),
      ...(browser?.target?.proxy === undefined ? [] : [describeProxy(browser.target.proxy)]),
      ...(browser === undefined ? [] : [browser.executablePath]),
    ]
    return html`<tr><td class="app">${app}</td><td class="muted">${session?.sessionId ?? ''}</td><td>${engine}</td><td class="words">${product}</td><td class="words">${browser?.build ?? 'not recorded'}</td><td class="words muted small">${notes.join(' · ')}</td></tr>`
  })
  const runtime = test.execution?.runtime
  const started = context.record.started
  const ran = runtime === undefined ? (started === undefined ? 'not recorded' : `Node ${started.node} on ${started.platform}`) : `Retest ${runtime.retest}, Node ${runtime.node} on ${runtime.platform}`
  const target = variant === undefined ? undefined : html`<p class="small words">Targets ${variant}</p>`
  return html`${target}<div class="table-wrap"><table><thead><tr><th scope="col">App</th><th scope="col">Session</th><th scope="col">Engine</th><th scope="col">Product</th><th scope="col">Build</th><th scope="col">Also</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted small">Ran with ${ran}</p>`
}

// A target's browser is its first one; Milestone 1's single browser serves the one app, `page`, and names no app.
function browserFor(app: string, test: TestResult, context: ReportContext): Browser | undefined {
  const target = test.variant?.[app]
  const named = context.record.browsers.find((browser) => browser.instance === undefined && browser.app === app && browser.target?.name === target)
  if (named !== undefined) return named
  return test.variant === undefined ? context.record.browser : undefined
}

function nativeRow(app: string, native: EventOfType<'native.started'>): Markup {
  const { identity } = native
  return html`<tr><td class="app">${app}</td><td class="muted">${native.sessionId}</td><td>${identity.platform === 'macos' ? 'macOS app' : 'iOS simulator app'}</td><td class="words">${native.product} ${identity.app.version ?? ''}</td><td class="words">${identity.app.build ?? 'not recorded'}</td><td class="words muted small">${describeNative(identity)}</td></tr>`
}

function describeNative(identity: NativeExecutionRecord): string {
  const device = identity.device === undefined ? [] : [`${identity.device.name} (${identity.device.type}) ${identity.device.udid}`]
  const executor = identity.executor
  return [
    `${identity.app.bundleId} at ${identity.app.path}, sha256 ${identity.app.sha256}`,
    `${identity.os.name} ${identity.os.version} (${identity.os.build})`,
    ...device,
    `${executor.name} ${executor.version}, commit ${executor.commit}${executor.commitVerified ? ', verified' : ', not verified'}, ${executor.origin}, products sha256 ${executor.productsSha256}`,
    `Xcode ${identity.xcode.version} (${identity.xcode.build})`,
  ].join(' · ')
}
