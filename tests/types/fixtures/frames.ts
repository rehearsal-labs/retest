import { expect, test, type Frame, type Locator, type Page } from '@rehearsal-labs/retest'

// page.frame() gives a frame with the finders and frame() alone: a frame inside a frame compiles, and nothing of a
// page's own, such as goto or the page matchers, is there. Each marked line fails the type check.
export async function pay(page: Page): Promise<void> {
  const payment: Frame = page.frame(page.locator('iframe[title="Secure payment"]'))
  await payment.getByLabel('Card number').fill('4242 4242 4242 4242')
  await payment.getByRole('button', { name: 'Pay' }).click()
  await expect(payment.getByText('Thank you')).toBeVisible()
  const inner: Frame = payment.frame(payment.locator('iframe'))
  const notes: Frame = inner.frame(inner.getByTestId('notes'))
  const note: Locator = notes.getByPlaceholder('Note').first()
  await note.fill('Leave at the door')
}

test('a frame has finders, and no page of its own', async ({ page }) => {
  const payment = page.frame(page.getByTestId('payment'))
  await payment.goto('/') // type-error TS2339 Property 'goto' does not exist on type 'Frame<false>'
  page.frame('iframe#payment') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'Locator<false>'
  payment.getByTestId('total').frame(payment.locator('iframe')) // type-error TS2339 Property 'frame' does not exist on type 'Locator<false>'
  await expect(payment).toHaveURL('/') // type-error TS2349 RetestTypeError<"toHaveURL is for a page. Use toBe on a value.">
})
