import type { TestContext } from 'node:test'
import type { AgentHostOptions, AgentOpenRequest } from '../../src/agent/host.ts'
import type { AgentSession } from '../../src/agent/session.ts'
import type { AgentLauncher, AgentLaunchers, AgentTarget } from '../../src/agent/targets.ts'
import type { WebEngine } from '../../src/browser/contract.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHost } from '../../src/agent/host.ts'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { browserPath } from '../support/test-browser.ts'
import { engineUnderTest, firefoxPath, webKitPath } from './engines.ts'

// What the agent session integration tests share: an agent host on the engine under test, as tests/integration/engines.ts
// names it, with the task app's password as its one secret, and the steps an agent takes to sign in through looks and
// references. Every host is closed after its test, and every browser it launched with it.

/** The password the task app takes for every account, which the host holds as the secret `password`. */
export { TASK_APP_PASSWORD }

/** The engine under test as an agent target: its engine, and the executable its driver starts. */
export function agentTarget(): AgentTarget {
  const engine = engineUnderTest().name
  const executablePath = engine === 'chromium' ? browserPath() : engine === 'firefox' ? firefoxPath() : webKitPath()
  return { engine, executablePath }
}

/** The engine the agent tests run on. */
export function engineName(): WebEngine {
  return engineUnderTest().name
}

/** The engines whose driver tells one element from another (`ElementIdentity` in the browser contract): Chromium's and Firefox's. */
export const pinningEngines: ReadonlySet<WebEngine> = new Set(['chromium', 'firefox', 'webkit'])

/**
 * Whether the engine under test pins elements, asserted against what `session` says, so an engine that gains or loses
 * element identity fails here instead of moving quietly from the cases of one rule to the other's.
 */
export function pinsOn(session: AgentSession): boolean {
  const expected = pinningEngines.has(engineName())
  assert.equal(session.pinsElements, expected, `the ${engineName()} driver ${expected ? 'pins elements' : 'pins no element yet'}`)
  return expected
}

/** An agent host on the engine under test, with its own log folder, closed after the test. */
export async function agentHost(t: TestContext, options: Partial<AgentHostOptions> = {}): Promise<{ host: AgentHost; logFolder: string }> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-agent-test-'))
  const engine = engineUnderTest()
  const launch: AgentLauncher = (launchOptions, timeoutMs) => engine.launch(launchOptions, timeoutMs)
  const launchers: AgentLaunchers = { [engine.name]: launch }
  const host = new AgentHost({
    targets: { browser: agentTarget() },
    budget: new SessionBudget({ perOwner: 4, host: 8 }),
    logFolder: folder,
    launchers,
    timeouts: { setup: 45_000, action: 5000, navigation: 10_000, assertion: 5000, cleanup: 5000 },
    secrets: { values: { password: { value: TASK_APP_PASSWORD } } },
    ...options,
  })
  t.after(async () => {
    const closed = await host.close()
    await rm(folder, { recursive: true, force: true })
    assert.deepEqual(closed, { ok: true }, 'the host closed every session and browser')
  })
  return { host, logFolder: folder }
}

/** Opens a session on the engine under test, failing the test with the refusal when it does not open. */
export async function openOn(host: AgentHost, request: Partial<AgentOpenRequest> & Pick<AgentOpenRequest, 'app' | 'purpose'>): Promise<AgentSession> {
  const opened = await host.open({ owner: 'agent-1', target: 'browser', engine: engineName(), ...request })
  assert.ok(opened.ok, opened.ok ? '' : `the session opened: ${opened.failure.message}`)
  return opened.session
}

/** The only element a look of `locator` lists, as a reference; the look must list exactly one. */
export async function onlyElement(session: AgentSession, locator: LocatorRecipe): Promise<{ sessionId: string; observationId: string; element: number }> {
  const observed = await session.observe(locator)
  assert.ok(observed.ok, observed.ok ? '' : observed.failure.message)
  assert.equal(observed.look.elements.length, 1, `one element of ${JSON.stringify(locator)}`)
  const [element] = observed.look.elements
  assert.ok(element !== undefined)
  return element.ref
}

/** Waits until a look of `locator` shows `text` as its one element's text, looking again as an assertion does. */
export async function waitForText(session: AgentSession, locator: LocatorRecipe, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  let last = ''
  for (;;) {
    const observed = await session.observe(locator)
    if (observed.ok && observed.look.observation.count === 1 && observed.look.observation.text === text) return
    last = observed.ok ? JSON.stringify(observed.look.observation.items) : observed.failure.message
    if (performance.now() > deadline) assert.fail(`${JSON.stringify(locator)} did not show ${JSON.stringify(text)} within ${timeoutMs} ms; last saw ${last}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Signs a session in to the task app as `account` the way an agent does: it looks at each field and acts on the
 * reference the look handed out, types the password as the host's secret, and clicks the button its look of buttons
 * listed as Sign in. Fields are looked for by their test ids, so these gates of sessions rest on no label rule: label
 * lookup is the locator cases' to prove on every engine, and on Firefox it currently misses a password field and,
 * during this lane, failed outright (both recorded in the agent sessions record).
 */
export async function signIn(session: AgentSession, account: string): Promise<void> {
  assertActed(await session.act({ kind: 'goto', url: '/login' }), 'opened the sign-in page')
  const user = await onlyElement(session, { by: 'testId', value: 'user' })
  assertActed(await session.act({ kind: 'fill', ref: user, value: account }), 'typed the user name')
  const password = await onlyElement(session, { by: 'testId', value: 'password' })
  assertActed(await session.act({ kind: 'fill', ref: password, value: { secret: 'password' } }), 'typed the password')
  const buttons = await session.observe({ by: 'role', role: 'button' })
  assert.ok(buttons.ok)
  const button = buttons.look.elements.find((element) => element.text === 'Sign in')
  assert.ok(button !== undefined, 'the look of buttons listed Sign in')
  assertActed(await session.act({ kind: 'click', ref: button.ref }), 'clicked Sign in')
  await waitForText(session, { by: 'testId', value: 'account' }, `Signed in as ${account}`)
}

/** Fails the test with the action's failure when it did not pass. */
export function assertActed(action: Awaited<ReturnType<AgentSession['act']>>, what: string): void {
  assert.ok(action.result.ok, `${what}: ${action.result.ok ? '' : action.result.failure.message}`)
  assert.equal(action.input, 'sent', `${what}: its input went`)
}
