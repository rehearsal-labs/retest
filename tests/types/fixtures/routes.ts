import { expect, test, type AbortReason, type DragOptions, type ElectronPage, type RouteAnswer, type RoutePattern } from '@rehearsal-labs/retest'

// A route takes a glob or a RegExp and an answer that is data: a response, or a refusal by one of Chrome's error names,
// never both. A drag takes the locator to drop on, never a string, and its steps as a number.
export const glob: RoutePattern = '**/api/tasks'
export const expression: RoutePattern = /\/api\/tasks\/\d+$/
export const refused: AbortReason = 'connectionrefused'
export const answer: RouteAnswer = { status: 200, contentType: 'application/json', body: JSON.stringify([{ title: 'Stubbed' }]) }
export const bytes: RouteAnswer = { contentType: 'image/png', body: new Uint8Array([137, 80, 78, 71]) }
export const steps: DragOptions = { steps: 10, timeout: 2000 }

test('routes and drags', async ({ page }) => {
  await page.route(glob, answer)
  await page.route(expression, { status: 404, body: 'Not found' })
  await page.route('**/api/slow', { abort: 'connectionrefused' })
  await page.route('**/api/slow', { abort: 'refused' }) // type-error TS2322 Type '"refused"' is not assignable to type
  await page.route('**/api/slow', { abort: 'connectionrefused', body: 'both' }) // type-error TS2345 Argument of type '{ abort: "connectionrefused"; body: string; }' is not assignable to parameter of type 'RouteAnswer'
  await page.route(42, answer) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'RoutePattern'
  await page.unroute(glob)
  await page.unroute(expression)

  await page.getByText('Write release notes').dragTo(page.getByTestId('done-column'))
  await page.getByTestId('handle').dragTo(page.getByTestId('slot-3'), { steps: 10 })
  await page.getByTestId('handle').dragTo('slot-3') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'Locator<boolean>'
  await page.getByTestId('handle').dragTo(page.getByTestId('slot-3'), { steps: '10' }) // type-error TS2322 Type 'string' is not assignable to type 'number'
  expect(refused).toBe('connectionrefused')
})

// An Electron app's window answers none of its requests with routes, and says so before anything runs.
export async function routedInElectron(desktop: ElectronPage): Promise<void> {
  await desktop.getByTestId('handle').dragTo(desktop.getByTestId('slot-3'))
  await desktop.route('**/api/tasks', answer) // type-error TS2349 This expression is not callable.
  await desktop.unroute('**/api/tasks') // type-error TS2349 This expression is not callable.
}
