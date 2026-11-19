import { chromium, defineConfig } from 'retest'

export const config = defineConfig({ apps: { web: chromium() }, evaluation: { judges: { motion: { adapter: './judge.ts', accepts: ['frames'] } }, defaultJudge: 'motion' } })
export default config

declare module 'retest' {
  interface Register { config: typeof config }
}
