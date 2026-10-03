import { capture } from '../shared/processes.ts'

/** What the system log says about Automation Mode while one runner started. */
export type AutomationModeStart = {
  /** True when macOS showed its "Enable UI Automation" dialog for this start. */
  readonly prompted: boolean
  /** Milliseconds from the dialog to someone authenticating, or null when nobody did in the window read. */
  readonly answeredAfterMs: number | null
  /** True when launchd started a new `automationmode-writer`, which holds no earlier authorization. */
  readonly newWriterDaemon: boolean
  readonly enabled: boolean
  /** True only when Automation Mode was enabled and no dialog was shown: nobody had to be at the machine. */
  readonly unattended: boolean
  readonly summary: string
  readonly events: readonly string[]
}

// Substrings of the messages testmanagerd and automationmode-writer log, as seen on macOS 27.0 with Xcode 26.5.
const DAEMON_LAUNCHED = 'writer daemon launched'
const PROMPTED = 'requires authentication to enable automation mode'
const AUTHENTICATED = 'serialized authorization'
const ENABLED = 'Executing request to ENABLE automation mode'
const ALREADY_ENABLED = 'Automation already enabled'

/**
 * Reads the unified log between `start` and `end` for the Automation Mode messages, and says whether this runner
 * start made macOS ask an administrator, and how long it waited.
 *
 * @example (await readAutomationModeStart(startedAt, new Date())).summary // 'enabled without a dialog (unattended)'
 */
export async function readAutomationModeStart(start: Date, end: Date): Promise<AutomationModeStart> {
  const messages = [DAEMON_LAUNCHED, PROMPTED, AUTHENTICATED, ENABLED, ALREADY_ENABLED].map((message) => `eventMessage CONTAINS "${message}"`).join(' OR ')
  const predicate = `(process == "testmanagerd" OR process == "automationmode-writer") AND (${messages})`
  const result = await capture('/usr/bin/log', ['show', '--start', localTime(start), '--end', localTime(end), '--style', 'compact', '--predicate', predicate], { timeoutMs: 120_000 })
  if (result.exitCode !== 0) throw new Error(`log show exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 200)}`)
  const lines = result.stdout.split('\n').filter((line) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}/.test(line))
  const at = (message: string): number | undefined => {
    const line = lines.find((candidate) => candidate.includes(message))
    return line === undefined ? undefined : new Date(line.slice(0, 23).replace(' ', 'T')).getTime()
  }
  const promptedAt = at(PROMPTED)
  const authenticatedAt = at(AUTHENTICATED)
  const enabled = at(ENABLED) !== undefined || at(ALREADY_ENABLED) !== undefined
  const prompted = promptedAt !== undefined
  const answeredAfterMs = promptedAt !== undefined && authenticatedAt !== undefined ? authenticatedAt - promptedAt : null
  const events = lines.map((line) => `${line.slice(11, 23)} ${[DAEMON_LAUNCHED, PROMPTED, AUTHENTICATED, ENABLED, ALREADY_ENABLED].find((message) => line.includes(message)) ?? ''}`)
  let summary: string
  if (prompted && answeredAfterMs !== null) summary = `macOS showed the Enable UI Automation dialog and someone authenticated after ${(answeredAfterMs / 1000).toFixed(1)} s (attended)`
  else if (prompted) summary = 'macOS showed the Enable UI Automation dialog and nobody authenticated'
  else if (enabled) summary = 'enabled without a dialog (unattended)'
  else summary = 'the system log shows no Automation Mode message for this start'
  return { prompted, answeredAfterMs, newWriterDaemon: at(DAEMON_LAUNCHED) !== undefined, enabled, unattended: enabled && !prompted, summary, events }
}

// `log show` takes local wall-clock times.
function localTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
