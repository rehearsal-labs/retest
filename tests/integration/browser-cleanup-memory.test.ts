import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { errorMessage } from '../../src/protocol/failures.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { useMetadataWorkerModule } from '../../src/shared/metadata-process.ts'
import { readProcessTableAsync } from '../../src/shared/process-ownership.ts'
import { linuxOnly } from '../support/platform-skip.ts'
import { browserPath } from '../support/test-browser.ts'

// Pages a run opens at once each start a whole-table reading while another is still being read. Each such reading once
// took a 64 MiB buffer of its own, which garbage collection does not count, and the spent ones stayed mapped side by side
// in one mapping. On an 8-CPU Linux machine with 32 GiB, that mapping grew past RAM and swap by the end of 1,000 passing
// tests; Linux then refused to fork the run for any reading, so it could not confirm that its browsers had ended, and
// two runs in six ended `cleanup_failed`. The stand-in worker refuses a fork the same way at a far smaller limit.
const readingsAtOnce = 12

test('a browser whose processes ended closes cleanly while the buffers of many earlier process-table readings are still kept', { skip: linuxOnly('the refused fork is Linux\'s heuristic overcommit') }, async (t) => {
  const restore = useMetadataWorkerModule(new URL('./fork-limit-worker.ts', import.meta.url))
  t.after(restore)
  const folder = await mkdtemp(join(tmpdir(), 'retest-cleanup-memory-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const browser = await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'browser.log'), headless: true })
  await browser.newPage({}, defaultTimeouts.setup)
  // What these readings find does not matter here, only the memory they leave.
  await Promise.allSettled(Array.from({ length: readingsAtOnce }, () => readProcessTableAsync()))
  const closed = await browser.close(defaultTimeouts.cleanup).then(
    () => 'closed',
    (error: unknown) => `${error instanceof BrowserError ? error.failure.class : 'failed'}: ${errorMessage(error)}`,
  )
  assert.deepEqual({ closed, processesLeft: signalGroup(browser.pid, 0) }, { closed: 'closed', processesLeft: false })
})
