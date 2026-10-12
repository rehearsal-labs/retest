import type { Failure } from './failures.ts'
import type { LocatorRecipe } from './locator.ts'
import { describeLocator, locatorRecipeSchema } from './locator.ts'
import { s, type Schema } from './schema.ts'

/** How many positions a drag moves the mouse through on its way to the target when the test gives no `steps`. */
export const defaultDragSteps = 5

/** The most positions a test may ask a drag to move through. Each one waits for a frame of the page. */
export const maxDragSteps = 100

/**
 * How a drag reached the page: through mouse events alone, or, once the press and the first moves began an HTML drag
 * (`draggable`, `dragstart`), through the browser's drag events, which carry the drag's `dataTransfer` to the drop.
 */
export type DragThrough = 'mouse' | 'drag-events'

export const dragThroughSchema: Schema<DragThrough> = s.enum(['mouse', 'drag-events'])

/** A drag as commands and events carry it: the element it drops on, and the positions the test asked for, when it did. */
type DragCall = { readonly target: LocatorRecipe; readonly steps?: number | undefined }

/**
 * A `dragTo` as its action's event records it: the element it drops on, the positions the test asked for when it did,
 * and, once it dropped, how it reached the page.
 */
export type DragRecord = { target: LocatorRecipe; steps?: number; through?: DragThrough }

export const dragRecordSchema: Schema<DragRecord> = s.object({
  target: locatorRecipeSchema,
  steps: s.optional(s.number({ integer: true, min: 1 })),
  through: s.optional(dragThroughSchema),
})

/**
 * What the test process and the parent both refuse, as `usage`, in a drag: `steps` that is not a whole number from 1
 * to `maxDragSteps`.
 *
 * @example dragProblem({ steps: 0 })?.message // 'dragTo() takes steps as a whole number from 1 to 100, received 0.'
 */
export function dragProblem({ steps }: { readonly steps?: number | undefined }): Failure | undefined {
  if (steps === undefined || (Number.isInteger(steps) && steps >= 1 && steps <= maxDragSteps)) return undefined
  return { class: 'usage', message: `dragTo() takes steps as a whole number from 1 to ${maxDragSteps}, received ${String(steps)}.`, details: { inputSent: false } }
}

/**
 * The arguments of a drag as a test writes them: the target's locator, and `steps` when the test gave it.
 *
 * @example describeDragArguments({ target: { by: 'testId', value: 'done' }, steps: 10 }) // "getByTestId('done'), { steps: 10 }"
 */
export function describeDragArguments({ target, steps }: DragCall): string {
  return `${describeLocator(target)}${steps === undefined ? '' : `, { steps: ${steps} }`}`
}
