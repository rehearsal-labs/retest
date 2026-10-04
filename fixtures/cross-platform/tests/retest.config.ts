import type { RetestConfig } from '@rehearsal-labs/retest'
import { chrome, defineConfig, env } from '@rehearsal-labs/retest'

// The config the cross-platform fixture's web test runs with. The service takes a port of its own choosing in the
// tests, so each run gives the address with `--base-url`; this one is the service's default port. The config is not
// registered: a registration would apply to every file of the repository's own TypeScript program.
const config: RetestConfig = defineConfig({
  apps: { web: chrome({ baseUrl: 'http://127.0.0.1:4310' }) },
  secrets: { password: env('RETEST_CROSS_PLATFORM_PASSWORD') },
})

export default config
