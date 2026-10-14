import type { IsolatedWorld } from './isolated-world.ts'
import { Deadline } from '../protocol/deadline.ts'
import { s } from '../protocol/schema.ts'

/**
 * How long, at most, a navigation waits after its document loaded for the document's first frame. Until a page that
 * has just loaded is drawn, nothing that waits for a frame can answer: an action's check that its element is still, or
 * Chrome's accessibility tree for a role. On a loaded runner that first frame came later than an action's whole
 * budget, so the navigation, which has a budget of its own, waits for it instead.
 */
export const firstFrameWaitMs: number = 2000

// The page's answer can trail its own timer while the page is busy; past this the call is given up as unanswered.
const answerMarginMs = 250

/**
 * Whether the document has been drawn, or is within `waitMs`: one that painted already has, one the browser does not
 * show draws no frames, and any other is drawn at its next animation frame. It runs in Retest's world, so a page that
 * replaced its own requestAnimationFrame cannot answer for the browser. It sends no input and changes nothing.
 */
export const firstFrameFunction: string = `function firstFrame(waitMs) {
  if (performance.getEntriesByType('paint').length > 0) return true
  if (document.visibilityState !== 'visible') return false
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs)
    requestAnimationFrame(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}`

/**
 * Waits up to `firstFrameWaitMs`, within `deadline`, for the document a navigation loaded to be drawn, and says
 * whether it was. A page the browser does not show answers at once, and one too busy to answer counts as not drawn.
 *
 * @example const drawn = await awaitFirstFrame(world, deadline)
 */
export async function awaitFirstFrame(world: IsolatedWorld, deadline: Deadline): Promise<boolean> {
  const waitMs = Math.min(firstFrameWaitMs, deadline.remainingMs)
  if (waitMs < 1) return false
  const budget = new Deadline(Math.min(waitMs + answerMarginMs, deadline.remainingMs), { signal: deadline.signal })
  try {
    return await world.call(firstFrameFunction, [waitMs], s.boolean(), budget)
  } catch {
    return false
  }
}
