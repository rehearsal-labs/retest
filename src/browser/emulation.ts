import type { CdpSession } from './cdp/session.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { Deadline } from '../protocol/deadline.ts'
import { s } from '../protocol/schema.ts'
import { request, sendOptions } from './cdp-results.ts'

const empty = s.object({})

/**
 * Makes a page pass for another screen: its viewport and pixel ratio, mobile layout, a touch screen, and the user
 * agent when one is given. Chrome keeps it for every document the page opens. A given user agent also empties
 * the client hints (`navigator.userAgentData` and the `Sec-CH-UA` headers), which would still describe this browser.
 *
 * @example await applyEmulation(session, emulationFor('Pixel 9', browser.version), deadline)
 */
export async function applyEmulation(session: CdpSession, emulation: Emulation, deadline: Deadline): Promise<void> {
  const { viewport, deviceScaleFactor, isMobile, touch, userAgent } = emulation
  const metrics = { width: viewport.width, height: viewport.height, deviceScaleFactor, mobile: isMobile }
  await request(session, 'Emulation.setDeviceMetricsOverride', metrics, empty, sendOptions(deadline))
  if (touch) await request(session, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, empty, sendOptions(deadline))
  if (userAgent !== undefined) await request(session, 'Emulation.setUserAgentOverride', { userAgent }, empty, sendOptions(deadline))
}
