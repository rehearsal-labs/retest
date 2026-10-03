import { chrome, defineConfig } from '@rehearsal-labs/retest'
import { Budget } from '@support/budgets'

// The task app from fixtures/task-app, at the address the check gives in TASK_APP_URL.
const baseUrl = process.env['TASK_APP_URL'] ?? 'http://127.0.0.1:4173'

export default defineConfig({
  apps: { web: chrome({ baseUrl }) },
  timeouts: { action: Budget.Action, assertion: Budget.Assertion, test: Budget.Test },
})
