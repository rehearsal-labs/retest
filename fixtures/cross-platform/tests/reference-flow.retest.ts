import type { NativePage, Page } from '@rehearsal-labs/retest'
import { randomBytes } from 'node:crypto'
import { expect, secret, test } from '@rehearsal-labs/retest'

// The reference flow on the cross-platform fixture: a task created in TaskPhone on an iOS simulator, marked done on
// the web front end in Chrome, and seen done in TaskDesk on macOS, all on one fixture service and signed in as the
// seeded account ada, whose password is the secret `password`. The harness supplies the config: `phone`, `web` and
// `desk` on that service, and `secretOrigins` naming both apps' bundle ids.
//
// Titles repeat in the service on purpose, so the task is followed by the id the service gave it and the title is only
// asserted on. A test cannot read text from a native element through the public API, so the web finds the id: in a
// fresh account the phone's task is the one task whose id the service assigned (seeded ids start with `seed-`), and
// the phone must then show that same id. Each client sees another's change only after the service's sync delay, and
// each wait for one is an ordinary assertion poll.

// The native type fixtures check the registered three-app context; this file runs in a config the harness writes.
const flowTest = test as typeof test & ((name: string, options: { apps: readonly ['phone', 'web', 'desk'] }, body: (apps: { phone: NativePage<'ios-simulator'>; web: Page<false>; desk: NativePage<'macos'> }) => Promise<void>) => void)

flowTest('creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id', { apps: ['phone', 'web', 'desk'] }, async ({ phone, web, desk }) => {
  const title = `Release checklist ${randomBytes(4).toString('hex')}`

  await phone.getByTestId('account-field').fill('ada')
  await phone.getByTestId('password-field').fill(secret('password'))
  await phone.getByTestId('sign-in-button').tap()
  await expect(phone.getByTestId('signed-in-account')).toHaveText('ada')
  await phone.getByTestId('new-task-title-field').fill(title)
  await phone.getByTestId('create-task-button').tap()
  await expect(phone.getByTestId('created-task-id')).toHaveText(/^task-[0-9a-f]{12}$/)
  await expect(phone.getByTestId('created-task-title')).toHaveText(title)
  await expect(phone.getByTestId('created-task-state')).toHaveText('Open')

  await web.goto('/')
  await web.getByTestId('account').fill('ada')
  await web.getByTestId('password').fill(secret('password'))
  await web.getByTestId('sign-in').click()
  await expect(web.getByTestId('signed-in-account')).toHaveText('ada')
  // The phone's task reaches the web once the sync delay has passed; until then the account holds no assigned id.
  const assigned = web.locator('[data-testid^="task-row-task-"]')
  await expect(assigned).toHaveCount(1)
  await web.locator('[data-testid^="open-task-task-"]').click()
  await expect(web).toHaveURL(/\/tasks\/task-[0-9a-f]{12}$/)
  const id = /\/tasks\/(task-[0-9a-f]{12})$/.exec(await web.url())?.[1]
  if (id === undefined) throw new Error(`The address names no task: ${await web.url()}`)
  await expect(phone.getByTestId('created-task-id')).toHaveText(id)

  await web.goto(`/tasks/${id}`)
  await expect(web.getByTestId('selected-task-id')).toHaveText(id)
  await expect(web.getByTestId('selected-task-title')).toHaveText(title)
  await expect(web.getByTestId('selected-task-state')).toHaveText('Open')
  await expect(web.getByTestId(`task-state-${id}`)).toHaveText('Open')

  // The desk opens the task by its id before the web changes it, so its last check waits through the sync delay.
  await desk.getByTestId('account-field').fill('ada')
  await desk.getByTestId('password-field').fill(secret('password'))
  await desk.getByTestId('sign-in-button').click()
  await expect(desk.getByTestId('signed-in-account')).toHaveText('ada')
  await desk.getByTestId('task-id-field').fill(id)
  await desk.getByTestId('show-task-button').click()
  await expect(desk.getByTestId('selected-task-id')).toHaveText(id)
  await expect(desk.getByTestId('selected-task-title')).toHaveText(title)
  await expect(desk.getByTestId(`task-state-${id}`)).toHaveText('Open')

  await web.getByTestId('edit-done').check()
  await web.getByTestId('save-task').click()
  await expect(web.getByTestId('save-status')).toHaveText('Saved revision 2.')
  await expect(web.getByTestId('selected-task-state')).toHaveText('Done')

  await expect(desk.getByTestId(`task-state-${id}`)).toHaveText('Done')
  await expect(desk.getByTestId('selected-task-state')).toHaveText('Done')
})
