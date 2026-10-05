import type { AgentOpened } from '../../src/agent/host.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { AgentHost } from '../../src/agent/host.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { agentFakeLauncher } from './agent-fakes.ts'

// Run by agent-host.test.ts in a process of its own, with no handler for unhandled rejections, as a host program has
// none: a launcher that throws before it returns, one that fails after the open stopped waiting, and a browser that
// arrives after the host closed and will not close. Retest leaving any rejection unhandled ends this process with a
// failure before it prints its line.

const targets = { chrome: { engine: 'chromium', executablePath: '/fake/chrome' } } as const
const request = { owner: 'agent-1', app: 'web', purpose: 'discovery', target: 'chrome', engine: 'chromium', waitMs: 300 } as const
const logFolder = '/tmp/retest-agent-unit-logs'

function classOf(opened: AgentOpened): string {
  return opened.ok ? 'opened' : opened.failure.class
}

async function thrown(): Promise<object> {
  const budget = new SessionBudget({ perOwner: 2, host: 2 })
  const fake = agentFakeLauncher({ launchThrows: 'launcher threw before returning a promise' })
  const host = new AgentHost({ targets, budget, logFolder, launchers: { chromium: fake.launch } })
  const opens: string[] = []
  for (const app of ['one', 'two']) opens.push(classOf(await host.open({ ...request, app })))
  const held = budget.snapshot().host
  return { opens, held, closed: (await host.close()).ok }
}

async function lateFailure(): Promise<object> {
  const failing = Promise.withResolvers<void>()
  const budget = new SessionBudget({ perOwner: 2, host: 2 })
  const fake = agentFakeLauncher({ launchAfter: failing.promise })
  const host = new AgentHost({ targets, budget, logFolder, launchers: { chromium: fake.launch }, timeouts: { setup: 30, cleanup: 300 } })
  const open = classOf(await host.open(request))
  failing.reject(new Error('the browser exited during its start'))
  await sleep(50)
  return { open, held: budget.snapshot().host, closed: (await host.close()).ok }
}

async function lateArrival(): Promise<object> {
  const arriving = Promise.withResolvers<void>()
  const fake = agentFakeLauncher({ launchAfter: arriving.promise, closeFails: 'the late browser would not close' })
  const host = new AgentHost({ targets, budget: new SessionBudget({ perOwner: 2, host: 2 }), logFolder, launchers: { chromium: fake.launch } })
  const opening = host.open(request)
  await sleep(30)
  const closing = host.close()
  setTimeout(() => arriving.resolve(), 50)
  const closed = await closing
  const open = classOf(await opening)
  // Anything left unhandled surfaces within this pause.
  await sleep(100)
  return { open, closed: closed.ok, browserClosed: fake.browsers[0]?.closed === true }
}

process.stdout.write(`${JSON.stringify({ thrown: await thrown(), lateFailure: await lateFailure(), lateArrival: await lateArrival() })}\n`)
