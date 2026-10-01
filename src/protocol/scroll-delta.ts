import type { Failure } from './failures.ts'

/** A scroll's delta as commands and events carry it: CSS pixels, positive right and down, 0 for an axis not given. */
type Delta = { readonly x: number; readonly y: number }

const axes = ['x', 'y'] as const

/**
 * What the test process and the parent both refuse, as `usage`, in a scroll's delta: an axis that is not a finite
 * number, or no distance on either.
 *
 * @example scrollProblem({ x: 0, y: 0 }) // { class: 'usage', message: 'scroll() takes x and y in CSS pixels, one of them other than 0, received { x: 0, y: 0 }.' }
 */
export function scrollProblem(delta: Delta): Failure | undefined {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) {
    return { class: 'usage', message: `scroll() takes x and y as finite numbers of CSS pixels, received ${describeScrollDelta(delta)}.` }
  }
  if (delta.x !== 0 || delta.y !== 0) return undefined
  return { class: 'usage', message: `scroll() takes x and y in CSS pixels, one of them other than 0, received ${describeScrollDelta(delta)}.` }
}

/**
 * Names a scroll's delta as a test writes it: the axes that move, or both when neither does.
 *
 * @example describeScrollDelta({ x: 0, y: 600 }) // '{ y: 600 }'
 */
export function describeScrollDelta(delta: Delta): string {
  const moving = axes.filter((axis) => delta[axis] !== 0)
  const shown = moving.length === 0 ? axes : moving
  return `{ ${shown.map((axis) => `${axis}: ${String(delta[axis])}`).join(', ')} }`
}
