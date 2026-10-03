import { chrome, defineConfig } from '@rehearsal-labs/retest'

// Every test file here imports something Retest does not load, and each must fail by name.
const baseUrl = process.env['TASK_APP_URL'] ?? 'http://127.0.0.1:4173'

export default defineConfig({ apps: { web: chrome({ baseUrl }) } })
