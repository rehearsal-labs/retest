import type { RecordIdentity } from '../../protocol/identity.ts'
import { ScreenshotLoopSource } from '../../media/capture.ts'
import { errorMessage } from '../../protocol/failures.ts'

/** The page's capture route, identity and loss, read without an input turn. */
export type CapturedFirefoxPage = {
  readonly identity: RecordIdentity | undefined
  readonly lostReason: string | undefined
  screenshot(timeoutMs: number): Promise<Uint8Array>
}

/**
 * Firefox's BiDi PNG screenshots, kept encoded, in a screenshot loop. BiDi 133 offers no pushed page-frame route.
 * Timestamps mark arrival on the run clock; the screenshot was read between request and arrival. Capture takes no
 * input turn, subscribes to no console events, and never runs a page script.
 */
export class FirefoxFrameSource extends ScreenshotLoopSource {
  constructor(page: CapturedFirefoxPage, asked: RecordIdentity) {
    const own = page.identity
    const refused = own === undefined
      ? `Retest has not named the session this page is, so it records nothing as ${asked.sessionId}.`
      : own.testId !== asked.testId || own.attemptId !== asked.attemptId || own.app !== asked.app || own.sessionId !== asked.sessionId
        ? `This page is session ${own.sessionId} of ${JSON.stringify(own.testId)}, not ${asked.sessionId} of ${JSON.stringify(asked.testId)}, so Retest records nothing of it as that session.`
        : undefined
    super({
      name: 'firefox',
      identity: own ?? asked,
      unavailable: () => refused ?? page.lostReason,
      grabTimeoutMs: 5000,
      grab: async (timeoutMs, _signal, withheld) => {
        if (withheld()) return { ok: false, problem: 'Pixels are withheld before the Firefox screenshot request.', withheld: true }
        try {
          const bytes = await page.screenshot(timeoutMs)
          return page.lostReason === undefined ? { ok: true, format: 'png', bytes } : { ok: false, problem: page.lostReason, lost: true }
        } catch (error) {
          return page.lostReason === undefined ? { ok: false, problem: errorMessage(error) } : { ok: false, problem: page.lostReason, lost: true }
        }
      },
    })
  }
}
