import { chromium, defineConfig, env } from 'retest'

export const config = defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }), phone: chromium({ emulate: 'Pixel 9' }) },
  defaultApp: 'web',
  evaluation: {
    judges: {
      visual: {
        adapter: 'retest/evaluation/ai-sdk',
        credentials: { apiKey: env('ANTHROPIC_API_KEY') },
        options: { provider: 'anthropic', model: 'claude-sonnet-5' },
        accepts: ['text', 'images'],
      },
      words: { adapter: './judges/words.ts', credentials: { apiKey: async () => 'from-a-vault' }, accepts: ['text'] },
    },
    defaultJudge: 'visual',
    timeoutMs: 20_000,
    limits: { callsPerTest: 3 },
  },
})

export default config

declare module 'retest' {
  interface Register {
    config: typeof config
  }
}
