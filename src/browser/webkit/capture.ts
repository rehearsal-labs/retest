import type { RecordIdentity } from '../../protocol/identity.ts'
import { ScreenshotLoopSource } from '../../media/capture.ts'
import { errorMessage } from '../../protocol/failures.ts'

/** What a WebKit page's capture needs of it: its own snapshot, why it is gone, if it is, and word when it goes. */
export interface CapturedPage {
  onLost(listener: (loss: { reason: string }) => void): () => void
  readonly lostReason: string | undefined
  /** One PNG of the page's viewport, as `Page.snapshotRect` paints it in the page's own web process. */
  screenshot(timeoutMs: number): Promise<Uint8Array>
}

// Each snapshot has the time a Firefox screenshot has. On a page that repaints every frame, 600 snapshots at 30 a second
// came back in 2.4 to 19.3 ms (median 6.3), WebKit build 2359 on macOS arm64, 9 October 2026.
const grabTimeoutMs = 5000

/**
 * WebKit's own snapshots of one page, as a frame source for the media process: a screenshot loop of `Page.snapshotRect`
 * on the page's target, which the page's web process paints from its document in one go, so each snapshot shows the page
 * in one state. Each is kept as the PNG the build encoded, never decoded, and stamped with the run's clock when it comes
 * back; it was painted between its request and its arrival. The build's screencast is not used: on macOS it handed over
 * pictures in which part of the page came from an earlier paint than the rest, and whole pictures from seconds before, as
 * if they were new (46 of 418 frames over 20 seconds of a page that repaints every frame, against none of 600
 * snapshots). Sends no input and runs no page script. It is a `FrameSource` under the name `webkit`.
 *
 * @example const source = new WebKitFrameSource(page, identity)
 */
export class WebKitFrameSource extends ScreenshotLoopSource {
  /** `refused` names why the source must not capture at all; its availability says so. */
  constructor(page: CapturedPage, identity: RecordIdentity, refused?: string) {
    super({
      name: 'webkit',
      identity,
      unavailable: () => refused ?? goneReason(page),
      grabTimeoutMs,
      onLost: (listener) => page.onLost(({ reason }) => listener(reason)),
      grab: async (timeoutMs, _signal, withheld) => {
        if (withheld()) return { ok: false, problem: 'Pixels are withheld before the WebKit snapshot request.', withheld: true }
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

function goneReason(page: CapturedPage): string | undefined {
  const lost = page.lostReason
  return lost === undefined ? undefined : `The page is gone, so WebKit cannot capture it: ${lost}.`
}
