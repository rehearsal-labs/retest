import { chromium, defineConfig } from '@rehearsal-labs/retest'

export const config = defineConfig({ apps: { web: chromium() }, evaluation: { judges: { motion: { adapter: './judge.ts', accepts: ['frames'] } }, defaultJudge: 'motion' } })
export default config

declare module '@rehearsal-labs/retest' {
  interface Register { config: typeof config }
}
