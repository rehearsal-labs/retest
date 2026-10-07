import type { RetestConfig } from '@rehearsal-labs/retest'
import { chromium, defineConfig } from '@rehearsal-labs/retest'

// The fake corpus judges, for `scripts/run-evaluation-corpus.ts --config fixtures/evaluation-corpus/judges/retest.config.ts`.
// The app is never opened: the corpus runner reads only the evaluation block.
const config: RetestConfig = defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) },
  evaluation: {
    judges: {
      perfect: { adapter: './fake-judges.ts', options: { behaviour: 'perfect' }, accepts: ['text', 'images', 'frames'] },
      'always-pass': { adapter: './fake-judges.ts', options: { behaviour: 'always-pass' }, accepts: ['text', 'images', 'frames'] },
      flip: { adapter: './fake-judges.ts', options: { behaviour: 'flip' }, accepts: ['text', 'images', 'frames'] },
      error: { adapter: './fake-judges.ts', options: { behaviour: 'error' }, accepts: ['text', 'images', 'frames'] },
    },
    defaultJudge: 'perfect',
    timeoutMs: 10_000,
  },
})

export default config
