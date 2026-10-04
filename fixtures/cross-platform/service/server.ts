import type { KnownClient } from './clients.ts'
import type { SyncLink } from './store.ts'
import { parseArgs } from 'node:util'
import { isKnownClient, KNOWN_CLIENTS } from './clients.ts'
import { DEFAULT_PORT, DEFAULT_SYNC_DELAY_MS, startTaskService } from './task-service.ts'

// The local service the cross-platform fixture apps share. It prints its address as its first line, then one line per
// request, reports failures it survives on stderr, and stops on SIGTERM or SIGINT with exit 0.
const USAGE = `Usage: node --conditions=retest-source fixtures/cross-platform/service/server.ts [options]
  --port <n>                  listen on 127.0.0.1:<n>; 0 takes a free port (default ${DEFAULT_PORT})
  --sync-delay-ms <n>         how long a change takes to reach the other clients (default ${DEFAULT_SYNC_DELAY_MS})
  --broken-sync               acknowledge every change and never pass it on to any other client
  --broken-sync=<client>      the same for that client only: ${KNOWN_CLIENTS.join(', ')}; may be given more than once
  --broken-sync=<from>:<to>   changes made by <from> never reach <to>, as in web:macos; may be given more than once
  --read-delay-ms <n>         hold each task read this long before answering, with the state from its arrival (default 0)
  --state <file>              keep the tasks in this JSON file across restarts (default: in memory only)
  --network-log <file>        write one JSON line per request to this file, replacing it
`

// parseArgs reads a string option only with a value, so the bare flag is given one of its own first.
const EVERY_OTHER_CLIENT = 'every-other-client'

try {
  const args = process.argv.slice(2).map((arg) => (arg === '--broken-sync' ? `--broken-sync=${EVERY_OTHER_CLIENT}` : arg))
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      'sync-delay-ms': { type: 'string' },
      'broken-sync': { type: 'string', multiple: true },
      'read-delay-ms': { type: 'string' },
      state: { type: 'string' },
      'network-log': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const port = values.port
  const delay = values['sync-delay-ms']
  const readDelay = values['read-delay-ms']
  const networkLog = values['network-log']
  const broken = brokenSync(values['broken-sync'])
  const service = await startTaskService({
    ...(port === undefined ? {} : { port: wholeNumber(port, '--port') }),
    ...(delay === undefined ? {} : { syncDelayMs: wholeNumber(delay, '--sync-delay-ms') }),
    ...(readDelay === undefined ? {} : { readDelayMs: wholeNumber(readDelay, '--read-delay-ms') }),
    ...(broken === undefined ? {} : { brokenSync: broken }),
    ...(values.state === undefined ? {} : { stateFile: values.state }),
    ...(networkLog === undefined ? {} : { networkLog }),
    printLine: (line) => process.stdout.write(`${line}\n`),
    reportError: (line) => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${service.url}\n`)
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      service.close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
  process.exitCode = 2
}

function brokenSync(given: readonly string[] | undefined): true | KnownClient[] | { links: SyncLink[] } | undefined {
  if (given === undefined) return undefined
  const linked = given.filter((value) => value.includes(':'))
  if (linked.length > 0 && linked.length < given.length) {
    throw new Error('--broken-sync=<from>:<to> cannot be given with --broken-sync or --broken-sync=<client>; give one form.')
  }
  if (linked.length > 0) return { links: linked.map(syncLink) }
  if (given.includes(EVERY_OTHER_CLIENT)) return true
  return given.map((client) => knownClient(client, 'as in --broken-sync=macos'))
}

function syncLink(value: string): SyncLink {
  const [from = '', to = '', ...rest] = value.split(':')
  if (rest.length > 0) throw new Error(`--broken-sync=<from>:<to> takes two clients, as in --broken-sync=web:macos, not ${value}.`)
  return { from: knownClient(from, 'as in --broken-sync=web:macos'), to: knownClient(to, 'as in --broken-sync=web:macos') }
}

function knownClient(text: string, example: string): KnownClient {
  if (!isKnownClient(text)) throw new Error(`--broken-sync takes one of ${KNOWN_CLIENTS.join(', ')}, ${example}, not ${text === '' ? 'an empty name' : text}.`)
  return text
}

function wholeNumber(text: string, flag: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`${flag} takes a whole number, not ${text}.`)
  return Number(text)
}
