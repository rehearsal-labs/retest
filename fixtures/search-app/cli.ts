import { parseArgs } from 'node:util'
import { defaultApiDelayMs, defaultDebounceMs, startSearchApp } from './server.ts'

const USAGE = `Usage: node fixtures/search-app/cli.ts [--api-delay-ms <milliseconds>] [--debounce-ms <milliseconds>]
Defaults: --api-delay-ms ${defaultApiDelayMs} --debounce-ms ${defaultDebounceMs}
`

try {
  const { values } = parseArgs({
    options: {
      'api-delay-ms': { type: 'string' },
      'debounce-ms': { type: 'string' },
    },
  })
  const apiDelay = values['api-delay-ms']
  const debounce = values['debounce-ms']
  const app = await startSearchApp({
    ...(apiDelay === undefined ? {} : { apiDelayMs: milliseconds(apiDelay, '--api-delay-ms') }),
    ...(debounce === undefined ? {} : { debounceMs: milliseconds(debounce, '--debounce-ms') }),
  })
  process.stdout.write(`${app.url}\n`)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  process.exitCode = 2
}

function milliseconds(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${flag} takes a whole number of milliseconds, not ${value}.`)
  return Number(value)
}
