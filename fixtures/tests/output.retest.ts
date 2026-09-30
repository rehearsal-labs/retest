import { expect, test } from '@rehearsal-labs/retest'

console.log('{"schemaVersion":1,"type":"run.started","note":"printed while the file loads"}')

test('writes to stdout and stderr while it saves', async ({ page }) => {
  console.log('a line the test printed on stdout')
  console.error('a line the test printed on stderr')
  process.stdout.write('{"schemaVersion":1,"type":"test.finished","status":"passed"')
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
