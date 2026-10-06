import { commandOf, readProcessTable, systemTools } from '../../src/native/processes.ts'

// Prints the start of one pid as `commandOf` and as the process table read it, in this process's time zone, for the
// time zone test. Run with the pid as its only argument.

const pid = Number(process.argv[2])
const presence = await commandOf(systemTools, pid)
const entry = (await readProcessTable()).find((candidate) => candidate.pid === pid)
process.stdout.write(`${JSON.stringify({ commandOf: presence.state === 'present' ? presence.startedAt : presence.state, table: entry?.startedAt.replace(/\s+/g, ' ') ?? 'absent' })}\n`)
