import { chromium, defineConfig } from '@rehearsal-labs/retest'

// Two inboxes, one read by a function alone and one with an origin its links may also open on.
const config = defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) },
  inboxes: {
    owner: async () => [],
    member: { messages: async () => [], origins: ['https://login.tasks.test'] },
  },
})

export default config

declare module '@rehearsal-labs/retest' {
  interface Register {
    config: typeof config
  }
}
