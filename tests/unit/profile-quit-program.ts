// A run's process caught by a quit before the browser it is launching has started: with `profile` it holds once its
// temporary profile exists, and with `launch <log>` its launch holds on a log that is a FIFO no one reads, which the
// launch opens once the profile exists and before it starts anything. The line `quit` on stdin then quits at once, as a
// second Ctrl+C does, through the process's exit hooks.
import { writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchBrowser } from '../../src/browser/launch.ts'
import { createTemporaryProfile } from '../../src/browser/profiles.ts'

const [mode, logFile] = process.argv.slice(2)

// Registered before anything Retest registers, so it runs first: once the parent reads it, the process is exiting and
// no launch can go on.
process.on('exit', () => writeSync(1, 'exiting\n'))
process.stdin.setEncoding('utf8')
process.stdin.on('data', (text: string) => {
  if (text.split('\n').includes('quit')) process.exit(130)
})

if (mode === 'profile') {
  writeSync(1, `profile ${await createTemporaryProfile(tmpdir())}\n`)
} else if (mode === 'launch' && logFile !== undefined) {
  await launchBrowser({ executablePath: process.execPath, logFile, headless: true })
} else {
  throw new Error(`Unknown mode ${String(mode)}`)
}
