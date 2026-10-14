import type { EventOfType } from './run-record.ts'
import { describeRouteSummary } from '../protocol/routes.ts'
import { plural, printable } from './format.ts'

/**
 * A change to an app's routes as reports name it: the call as the test wrote it, with what an added route answers, or
 * how many routes a removal took away; or a request a route could not answer because Chrome refused its answer.
 *
 * @example describeRouteChange({ operation: 'add', pattern: '/tasks/i', answer: { status: 200, bodyBytes: 2 } }) // 'page.route(/tasks/i) answers 200, 2 bytes'
 */
export function describeRouteChange(event: Pick<EventOfType<'route'>, 'operation' | 'pattern' | 'answer' | 'removed' | 'url'>): string {
  const pattern = printable(event.pattern)
  if (event.operation === 'remove') return `page.unroute(${pattern})${event.removed === undefined ? '' : ` removed ${plural(event.removed, 'route')}`}`
  if (event.operation === 'answer') return `page.route(${pattern}) could not answer ${printable(event.url ?? 'a request')}, which Retest failed`
  const answer = event.answer === undefined ? '' : ` ${'abort' in event.answer ? '' : 'answers '}${describeRouteSummary(event.answer)}`
  return `page.route(${pattern})${answer}`
}
