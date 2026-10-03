import type { Title } from '../support/titles'
import { expect, test } from '@rehearsal-labs/retest'
import { TaskPage } from '@support/task-page'
import { timeZone } from '../support/clock.mjs'
import { shownTitle } from '../support/labels.js'
import { Priority } from '../support/models'
import { releaseTitle } from '../support/titles'

test('saves a task through a page object', async ({ page }) => {
  const tasks = new TaskPage(page, 'tasks')
  const title: Title = releaseTitle()
  expect(tasks.name).toBe('tasks')
  expect(Priority.describe(Priority.high)).toBe('priority high')
  expect(timeZone).toBe('UTC')
  await tasks.open()
  await tasks.add(title)
  await tasks.expectSaved(shownTitle(title))
})
