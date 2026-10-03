import { test } from '@rehearsal-labs/retest'
import { TaskPage } from '@support/task-page'
import { failLoudly } from '../support/failures'

// Both tests fail on purpose: each failure must name the TypeScript line it happened on.

test('a failed check names its TypeScript line', async ({ page }) => {
  const tasks = new TaskPage(page, 'locations')
  await tasks.open()
  await tasks.add('Release checklist')
  await tasks.expectSaved('Something else')
})

test('a thrown error names its TypeScript line', async () => {
  try {
    failLoudly()
  } catch (error) {
    // The stack goes to the test file's output, where the check reads it.
    console.log(error instanceof Error ? error.stack : String(error))
    throw error
  }
})
