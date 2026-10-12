import type { Same } from './support/same.ts'
import { chromium, defineConfig, expect, inbox, test, type InboxContext, type InboxMessage, type InboxSource, type ReceivedMessage } from '@rehearsal-labs/retest'

// An inbox's function is called with a signal, aborted once Retest stops waiting for the messages, and gives the
// mailbox's messages. A code goes only to fill() and a link only to goto(); neither is ever a string. This program has
// no registered config, so any inbox name type-checks.
export const signal: Same<InboxContext['signal'], AbortSignal> = true

export async function readMailbox({ signal: stop }: InboxContext): Promise<InboxMessage[]> {
  const response = await fetch('http://127.0.0.1:4173/outbox', { signal: stop })
  return [{ subject: await response.text(), from: 'noreply@tasks.test', text: '', codes: ['482913'], links: [{ url: 'http://127.0.0.1:4173/magic', text: 'Sign in' }], receivedAt: new Date() }]
}

export const source: InboxSource = readMailbox

export const inboxes = defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) },
  inboxes: {
    owner: readMailbox,
    member: { messages: async () => [], origins: ['https://login.tasks.test'] },
    later: () => [{ subject: 'Hi', from: 'a@tasks.test', text: 'Hi', codes: [], links: [], receivedAt: '2026-10-11T09:15:00Z' }],
  },
})

export const missingTime = defineConfig({
  apps: { web: chromium() },
  inboxes: { owner: () => [{ subject: 'Hi', from: 'a@tasks.test', text: 'Hi', codes: [], links: [] }] }, // type-error TS2322 Property 'receivedAt' is missing
})

test('a code and a link from an inbox', async ({ page }) => {
  const message: ReceivedMessage = await inbox('owner').latest({ subject: /code/i, timeout: 10_000 })
  const subject: string = message.subject
  await page.getByLabel(subject).fill(message.code)
  await page.goto(message.link())
  await page.goto(message.link(2))
  await page.goto(message.link({ path: '/verify' }))
  await page.goto(message.code) // type-error TS2345 Argument of type 'InboxCode' is not assignable to parameter of type 'string | InboxLink'
  await page.getByLabel('Code').fill(message.link()) // type-error TS2345 Argument of type 'InboxLink' is not assignable to parameter of type 'string | Secret'
  await page.getByText(message.code).click() // type-error TS2345 Argument of type 'InboxCode' is not assignable to parameter of type 'string | RegExp'
  const code: string = message.code // type-error TS2322 Type 'InboxCode' is not assignable to type 'string'
  const address: string = message.link() // type-error TS2322 Type 'InboxLink' is not assignable to type 'string'
  expect(message.code).toBe('482913') // type-error TS2339 Property 'toBe' does not exist on type 'RetestTypeError<"A secret cannot be compared or printed.">'
  await inbox('owner').latest({ subject: 3 }) // type-error TS2322 Type 'number' is not assignable to type 'string | RegExp | undefined'
  message.link('2') // type-error TS2345 Argument of type '"2"' is not assignable to parameter of type 'LinkChoice | undefined'
  expect(code + address).toContain('x')
})
