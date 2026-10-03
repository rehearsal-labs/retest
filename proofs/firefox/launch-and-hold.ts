import { firefoxPath, launchRoute } from './firefox-session.ts'
import { launchFirefox } from './launch-firefox.ts'

/**
 * Launches Firefox with a session, prints one JSON line naming it, and holds it until this process is killed. The
 * orphan test and `run.ts` kill this process with SIGKILL, as a runner that crashed would end, to show what a
 * Firefox is left doing and that the next launch ends it.
 *
 *   node --conditions=retest-source proofs/firefox/launch-and-hold.ts <log file>
 */

const logFile = process.argv[2]
if (logFile === undefined) throw new Error('Pass the log file for Firefox as the first argument.')
const { firefox } = await launchFirefox({
  executablePath: firefoxPath(),
  logFile,
  headless: true,
  route: launchRoute(),
  timeoutMs: 20_000,
  commandTimeoutMs: 10_000,
  onDiagnostic: () => {},
})
process.stdout.write(`${JSON.stringify({ pid: firefox.pid, folder: firefox.folder, webSocketUrl: firefox.webSocketUrl })}\n`)
// Holds the process, and with it the session's connection, until it is killed.
setInterval(() => {}, 60_000)
