import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { runFiles } from '../../src/runner/run.ts'
import { fakeLauncher } from './fake-browser.ts'
import { newRunFolder, rootDir, supportFile } from './run-harness.ts'

// Starts a run whose test loops forever, then exits the process as soon as the test file's process
// reports its id, so the caller can check that the exit took the child with it.

const { launch } = fakeLauncher()
void runFiles(
  {
    files: [supportFile('endless-loop.retest.ts')],
    rootDir,
    apps: { kind: 'browser', browserPath: '/fake/chromium', baseUrl: 'http://127.0.0.1:4173' },
    timeouts: { ...defaultTimeouts, test: 60_000 },
    outputDir: newRunFolder(),
    headless: true,
    signal: new AbortController().signal,
    onOutput: ({ text }) => {
      const pid = /pid (\d+)/.exec(text)?.[1]
      if (pid === undefined) return
      process.stdout.write(`child ${pid}\n`, () => process.exit(3))
    },
  },
  [],
  launch,
)
