import type { RetestEvent } from '../../protocol/events.ts'
import { join } from 'node:path'
import { retestEventSchema } from '../../protocol/events.ts'
import { runResultSchema, type RunResult } from '../../protocol/result.ts'
import { eventsFile, resultFile } from '../../protocol/run-folder.ts'
import { parse, type Issue } from '../../protocol/schema.ts'
import { CliError } from '../errors.ts'
import { readTextIfPresent, statIfPresent } from '../file-system.ts'
import { rebuildResult } from './rebuild-result.ts'

/** A run folder as `inspect` read it. Without `result.json` the result is rebuilt and never complete. */
export type RunFolder = {
  source: 'result.json' | 'events.jsonl'
  result: RunResult
  events: RetestEvent[]
  /** What the reader should know about how the folder was read. */
  warnings: string[]
}

/** Events read from `events.jsonl`. `tornLine` is a last line cut off while it was written. */
export type EventsReading = { ok: true; events: RetestEvent[]; tornLine?: number } | { ok: false; problem: string }

/**
 * Reads and validates a run folder. A folder that is missing, unreadable or invalid throws a `CliError`.
 *
 * @example readRunFolder('/work/.retest/runs/latest', '.retest/runs/latest').result.exitCode
 */
export function readRunFolder(folder: string, shown: string): RunFolder {
  const stats = statIfPresent(folder)
  if (stats === undefined) throw new CliError(`No run folder at ${shown}.`)
  if (!stats.isDirectory()) throw new CliError(`${shown} is a file, not a run folder.`)
  const resultText = readTextIfPresent(join(folder, resultFile))
  const eventsText = readTextIfPresent(join(folder, eventsFile))
  if (resultText !== undefined) return withResult(readResult(resultText), eventsText)
  if (eventsText === undefined) {
    throw new CliError(`${shown} has neither ${resultFile} nor ${eventsFile}, so it is not a run folder.`)
  }
  const reading = readEvents(eventsText)
  if (!reading.ok) throw new CliError(`${eventsFile} cannot be read: ${reading.problem}.`)
  if (reading.events.length === 0) {
    throw new CliError(`${shown} has no ${resultFile} and no events: the run stopped before it recorded anything.`)
  }
  const warnings = [
    `${resultFile} is missing, so the run did not finish. This result is rebuilt from ${reading.events.length} events and marked incomplete.`,
    ...tornWarning(reading),
  ]
  return { source: 'events.jsonl', result: rebuildResult(reading.events), events: reading.events, warnings }
}

function withResult(result: RunResult, eventsText: string | undefined): RunFolder {
  const found: Pick<RunFolder, 'source' | 'result'> = { source: 'result.json', result }
  if (eventsText === undefined) {
    return { ...found, events: [], warnings: [`${eventsFile} is missing, so steps and check details are not shown.`] }
  }
  const reading = readEvents(eventsText)
  if (!reading.ok) {
    const warning = `${eventsFile} cannot be read (${reading.problem}), so steps and check details are not shown.`
    return { ...found, events: [], warnings: [warning] }
  }
  const runId = reading.events[0]?.runId
  if (runId !== undefined && runId !== result.runId) {
    const warning = `${eventsFile} belongs to run ${runId}, not ${result.runId}, so its events are not shown.`
    return { ...found, events: [], warnings: [warning] }
  }
  return { ...found, events: reading.events, warnings: tornWarning(reading) }
}

function tornWarning(reading: EventsReading): string[] {
  if (!reading.ok || reading.tornLine === undefined) return []
  return [`${eventsFile} ends in a line cut off while it was written (line ${reading.tornLine}); it was left out.`]
}

function readResult(text: string): RunResult {
  const json = parseJson(text)
  if (!json.ok) throw new CliError(`${resultFile} is not valid JSON.`)
  const parsed = parse(runResultSchema, json.value)
  if (!parsed.ok)
    throw new CliError(`${resultFile} does not match the version 1 result: ${describeIssues(parsed.issues)}.`)
  return parsed.value
}

/**
 * Parses and validates each line of `events.jsonl`. Only the last line may be cut off; a bad line
 * anywhere else, events from two runs or events out of order make the file unreadable.
 *
 * @example readEvents(readFileSync('events.jsonl', 'utf8'))
 */
export function readEvents(text: string): EventsReading {
  const lines = text.split('\n')
  const tail = lines.pop() ?? ''
  const events: RetestEvent[] = []
  for (const [index, line] of lines.entries()) {
    const json = parseJson(line)
    if (!json.ok) return { ok: false, problem: `line ${index + 1} is not valid JSON` }
    const problem = addEvent(events, json.value, index + 1)
    if (problem !== undefined) return { ok: false, problem }
  }
  const tailNumber = lines.length + 1
  const tailJson = tail === '' ? undefined : parseJson(tail)
  if (tailJson?.ok === true) {
    const problem = addEvent(events, tailJson.value, tailNumber)
    if (problem !== undefined) return { ok: false, problem }
  }
  return tailJson?.ok === false ? { ok: true, events, tornLine: tailNumber } : { ok: true, events }
}

function addEvent(events: RetestEvent[], value: unknown, line: number): string | undefined {
  const parsed = parse(retestEventSchema, value)
  if (!parsed.ok) return `line ${line} is not a version 1 event: ${describeIssues(parsed.issues)}`
  const event = parsed.value
  const first = events[0]
  const previous = events.at(-1)
  if (first !== undefined && event.runId !== first.runId) {
    return `line ${line} belongs to run ${event.runId}, not ${first.runId}`
  }
  if (previous !== undefined && event.sequence <= previous.sequence) {
    return `line ${line} has sequence ${event.sequence}, which does not follow ${previous.sequence}`
  }
  events.push(event)
  return undefined
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    const value: unknown = JSON.parse(text)
    return { ok: true, value }
  } catch {
    return { ok: false }
  }
}

function describeIssues(issues: Issue[]): string {
  const shown = issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`)
  const more = issues.length > shown.length ? `, and ${issues.length - shown.length} more` : ''
  return `${shown.join('; ')}${more}`
}
