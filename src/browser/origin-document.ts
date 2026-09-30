import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { Deadline } from '../protocol/deadline.ts'
import { s } from '../protocol/schema.ts'
import { BrowserError } from './browser-error.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { Dispatch } from './dispatch.ts'
import { IsolatedWorld } from './isolated-world.ts'
import { navigate } from './navigation.ts'

/** A browser context, and the connection of the browser it is in. */
export type ContextHandle = { connection: CdpConnection; browserContextId: string }

const empty = s.object({})
const targetSchema = s.object({ targetId: s.string() })
const frameTreeSchema = s.object({ frameTree: s.object({ frame: s.object({ id: s.string() }) }) })
const pausedSchema = s.object({ requestId: s.string(), resourceType: s.string() })

/**
 * Opens each origin in a background tab of the browser context, with an empty document Retest serves itself, and
 * runs `work` in Retest's world there. No request reaches the site and none of its code runs: every request the
 * tab makes is answered or refused by Retest, and service workers are bypassed. Closes the tab afterwards.
 *
 * @example await inOriginDocuments({ connection, browserContextId }, origins, (world) => world.call(readStorageFunction, [], schema, deadline), deadline)
 */
export async function inOriginDocuments<T>(
  { connection, browserContextId }: ContextHandle,
  origins: readonly string[],
  work: (world: IsolatedWorld, origin: string) => Promise<T>,
  deadline: Deadline,
): Promise<T[]> {
  if (origins.length === 0) return []
  const params = { url: 'about:blank', browserContextId, background: true }
  const { targetId } = await request(connection, 'Target.createTarget', params, targetSchema, sendOptions(deadline))
  try {
    const session = await connection.attach(targetId, sendOptions(deadline))
    const served = serveEmptyDocuments(session)
    try {
      // Chrome bypasses service workers only for a session whose Network domain is on.
      await request(session, 'Network.enable', {}, empty, sendOptions(deadline))
      await request(session, 'Network.setBypassServiceWorker', { bypass: true }, empty, sendOptions(deadline))
      await request(session, 'Fetch.enable', { patterns: [{ urlPattern: '*' }] }, empty, sendOptions(deadline))
      await request(session, 'Page.enable', undefined, empty, sendOptions(deadline))
      await request(session, 'Page.setLifecycleEventsEnabled', { enabled: true }, empty, sendOptions(deadline))
      const results: T[] = []
      for (const origin of origins) results.push(await work(await openOrigin(session, origin, deadline), origin))
      return results
    } finally {
      served.stop()
    }
  } finally {
    await connection.send('Target.closeTarget', { targetId }, sendOptions(deadline)).catch(() => {
      // Closing the browser context closes the tab with it, and the error that matters is the work's own.
    })
  }
}

async function openOrigin(session: CdpSession, origin: string, deadline: Deadline): Promise<IsolatedWorld> {
  const frameId = await mainFrameId(session, deadline)
  const context = { session, baseUrl: undefined, mainFrameId: () => frameId, currentUrl: () => undefined, proxyServer: undefined }
  const opened = await navigate(context, new URL('/', origin).href, deadline, new Dispatch())
  if (!opened.ok) {
    throw new BrowserError({ class: 'setup_failed', message: `Could not open an empty document of ${origin}: ${opened.failure.message}` })
  }
  return new IsolatedWorld(session, () => frameId)
}

async function mainFrameId(session: CdpSession, deadline: Deadline): Promise<string> {
  return (await request(session, 'Page.getFrameTree', undefined, frameTreeSchema, sendOptions(deadline))).frameTree.frame.id
}

// Answers the tab's document requests with an empty page and refuses anything else, such as a favicon.
function serveEmptyDocuments(session: CdpSession): { stop: () => void } {
  const stop = session.on('Fetch.requestPaused', (params) => {
    const paused = readProtocol(pausedSchema, params, { method: 'Fetch.requestPaused', sessionId: session.id })
    const answer =
      paused.resourceType === 'Document'
        ? session.send('Fetch.fulfillRequest', {
            requestId: paused.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          })
        : session.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' })
    answer.catch(() => {
      // A request left unanswered fails the navigation waiting on it, which reports the problem.
    })
  })
  return { stop }
}
