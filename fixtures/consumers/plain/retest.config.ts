import { chrome, defineConfig } from '@rehearsal-labs/retest'

// No tsconfig.json: erasable TypeScript and plain JavaScript, imported by their own file names.
const baseUrl = process.env['TASK_APP_URL'] ?? 'http://127.0.0.1:4173'

export default defineConfig({ apps: { web: chrome({ baseUrl }) } })
