import type { Readable } from 'node:stream'
import type { OutputRedactor } from './contract.ts'
import { errorMessage } from '../protocol/failures.ts'

const longestLine = 64 * 1024
const pendingBytesLimit = 1024 * 1024
const pendingLinesLimit = 1024

/**
 * Redacts complete lines before queuing them, then waits for both streams, all writes and the log's close.
 * An oversized line is discarded through its newline: writing pieces could expose a secret spanning the cut.
 * Both queued bytes and lines are bounded, and every loss is counted in the log and returned to cleanup.
 */
export function writeRedactedLog(streams: readonly Readable[], log: { writeFile(text: string): Promise<void>; close(): Promise<void> }, redact: (text: string) => string, redactStream?: () => OutputRedactor): { closed: Promise<string[]>; cancel(): void } {
  const finished = Promise.withResolvers<string[]>()
  const problems: string[] = []
  let written = Promise.resolve()
  let pendingBytes = 0
  let pendingLines = 0
  let oversized = 0
  let overflowed = 0
  let writeFailed = false
  let open = streams.length
  let canceled = false
  const addProblem = (message: string): void => {
    if (!problems.includes(message) && problems.length < 8) problems.push(message)
  }
  const increment = (count: number): number => Math.min(Number.MAX_SAFE_INTEGER, count + 1)
  const write = (text: string): void => {
    if (text === '') return
    const bytes = Buffer.byteLength(text)
    if (writeFailed || bytes > pendingBytesLimit - pendingBytes || pendingLines >= pendingLinesLimit) {
      overflowed = increment(overflowed)
      return
    }
    pendingBytes += bytes
    pendingLines += 1
    written = written.then(async () => {
      try {
        if (canceled) {
          overflowed = increment(overflowed)
          return
        }
        await log.writeFile(text)
      } catch (error) {
        writeFailed = true
        addProblem(`Could not write the browser's redacted output: ${errorMessage(error)}`)
      } finally {
        pendingBytes -= bytes
        pendingLines -= 1
      }
    })
  }
  const close = (): void => {
    void written.then(async () => {
      const losses = [
        ...(oversized === 0 ? [] : [`${oversized} oversized output lines`]),
        ...(overflowed === 0 ? [] : [`${overflowed} output lines beyond the pending log limit`]),
      ]
      if (losses.length > 0) {
        const message = `Retest dropped ${losses.join(' and ')} from the browser log.`
        addProblem(message)
        try {
          const marker = `[retest] ${message}\n`
          const redacting = redactStream?.()
          await log.writeFile(redacting === undefined ? redact(marker) : redacting.write(marker) + redacting.end())
        } catch (error) {
          addProblem(`Could not write the browser log's loss report: ${errorMessage(error)}`)
        }
      }
      try { await log.close() } catch (error) { addProblem(`Could not close the browser log: ${errorMessage(error)}`) }
      finished.resolve(problems)
    })
  }
  for (const stream of streams) {
    let partial = ''
    let dropping = false
    let redactionFailed = false
    const freshRedactor = (): OutputRedactor | undefined => {
      try {
        return redactStream?.()
      } catch {
        redactionFailed = true
        addProblem('The browser output redactor failed; its output was dropped.')
        return undefined
      }
    }
    let redacting = freshRedactor()
    const line = (text: string): void => {
      if (redactionFailed) return
      try {
        write(redacting === undefined ? `${redact(text)}\n` : redacting.write(`${text}\n`))
      } catch {
        redactionFailed = true
        addProblem('The browser output redactor failed; its output was dropped.')
      }
    }
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      let start = 0
      while (start < chunk.length) {
        const newline = chunk.indexOf('\n', start)
        const end = newline < 0 ? chunk.length : newline
        if (!dropping) {
          if (partial.length + end - start > longestLine) {
            partial = ''
            dropping = true
            oversized = increment(oversized)
            // A held secret prefix belonged to the lost line too; never join it to a later line or flush it raw.
            redacting = freshRedactor()
          } else partial += chunk.slice(start, end)
        }
        if (newline < 0) break
        if (!dropping) line(partial)
        partial = ''
        dropping = false
        start = newline + 1
      }
    })
    stream.on('error', (error: unknown) => addProblem(`Could not read the browser's output: ${errorMessage(error)}`))
    stream.once('close', () => {
      if (!canceled && !dropping && partial !== '') line(partial)
      if (!canceled && !redactionFailed) {
        try { if (redacting !== undefined) write(redacting.end()) } catch { addProblem('The browser output redactor failed; its output was dropped.') }
      }
      open -= 1
      if (open === 0) close()
    })
  }
  if (open === 0) close()
  return { closed: finished.promise, cancel: () => {
    canceled = true
    for (const stream of streams) stream.destroy()
  } }
}
