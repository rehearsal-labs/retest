import type { RetestConfig } from '@rehearsal-labs/retest'
import { app, defineConfig } from '@rehearsal-labs/retest'
import { conformanceBaseUrl, conformanceTarget } from '../config.ts'

// Browser projects: one app with two targets on the engine the runner names, each opening its pages at its own size.
// A test that uses the app runs once per target, and `--target web=narrow` keeps one.
const config: RetestConfig = defineConfig({
  apps: {
    web: app({
      baseUrl: conformanceBaseUrl(),
      targets: {
        wide: conformanceTarget({ viewport: { width: 1280, height: 720 } }),
        narrow: conformanceTarget({ viewport: { width: 600, height: 800 } }),
      },
    }),
  },
})

export default config
