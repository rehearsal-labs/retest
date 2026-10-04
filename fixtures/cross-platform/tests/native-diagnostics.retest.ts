import type { NativePage } from '@rehearsal-labs/retest'
import { expect, secret, test } from '@rehearsal-labs/retest'

// Native diagnostics through the runner on the cross-platform fixture. The harness supplies the config: `phone` and
// `desk` declare the fixture service's network log, each with its own client name, and keep their standard output,
// which is the default; `plain` is TaskDesk with no declared source, and `quiet` is TaskDesk with `logs: 'none'`. Every
// app signs in as the seeded account ada, whose password is the secret `password`, so each writes its request lines
// and the service writes its records while the test runs. The judge is the harness's fake, which passes a criterion
// named `pass` and records what it was shown.

// The native type fixtures check registered native contexts; this file runs in a config the harness writes.
const pairTest = test as typeof test & ((name: string, options: { apps: readonly ['phone', 'desk'] }, body: (apps: { phone: NativePage<'ios-simulator'>; desk: NativePage<'macos'> }) => Promise<void>) => void)
const plainTest = test as typeof test & ((name: string, options: { apps: readonly ['plain'] }, body: (apps: { plain: NativePage<'macos'> }) => Promise<void>) => void)
const quietTest = test as typeof test & ((name: string, options: { apps: readonly ['quiet'] }, body: (apps: { quiet: NativePage<'macos'> }) => Promise<void>) => void)

async function signInOnDesk(desk: NativePage<'macos'>): Promise<void> {
  await desk.getByTestId('account-field').fill('ada')
  await desk.getByTestId('password-field').fill(secret('password'))
  await desk.getByTestId('sign-in-button').click()
  await expect(desk.getByTestId('signed-in-account')).toHaveText('ada')
}

pairTest('the phone and the desk keep their own log lines and network records, and the judge sees the phone', { apps: ['phone', 'desk'] }, async ({ phone, desk }) => {
  await phone.getByTestId('account-field').fill('ada')
  await phone.getByTestId('password-field').fill(secret('password'))
  await phone.getByTestId('sign-in-button').tap()
  await expect(phone.getByTestId('signed-in-account')).toHaveText('ada')
  await phone.getByTestId('new-task-title-field').fill('Diagnostics task')
  await phone.getByTestId('create-task-button').tap()
  await expect(phone.getByTestId('created-task-id')).toHaveText(/^task-[0-9a-f]{12}$/)
  await expect(phone.getByTestId('created-task-title')).toHaveText('Diagnostics task')
  await test.evaluate({ requirement: { pass: 'The phone shows that ada is signed in.' }, evidence: { app: 'phone', capture: 'screenshot' } })

  await signInOnDesk(desk)
})

plainTest('TaskDesk with no declared source keeps its standard output and has no network source', { apps: ['plain'] }, async ({ plain }) => {
  await signInOnDesk(plain)
})

quietTest('TaskDesk that keeps no log is launched by its executor and has neither source', { apps: ['quiet'] }, async ({ quiet }) => {
  await signInOnDesk(quiet)
})
