// A wrapper around the stand-in supervisor for the launch's-end cases: it runs the stand-in, and for each `terminate`
// the stand-in answered `terminated`, it adds a child of the process just ended to the world, as a process that started
// another between the reading and its own end does, up to the world's `spawnLimit` children in all. Each child is listed
// as an orphan too, so `strays` answers it once nothing runs behind it, as the crate does. The arguments are the
// stand-in's path, then what the stand-in itself is given.
import type { StandInWorld } from './process-supervisor-world.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { withWorld } from './process-supervisor-world-lock.ts'

const [standIn, file, verb, ...rest] = process.argv.slice(2)
if (standIn === undefined || file === undefined || verb === undefined) throw new Error('The wrapper needs the stand-in, its world file and a verb.')
const reply = execFileSync(process.execPath, [standIn, file, verb, ...rest], { encoding: 'utf8' })
if (verb === 'terminate' && reply.includes('"outcome":"terminated"')) {
  withWorld(file, () => {
    const world: StandInWorld & { spawned?: number; spawnLimit?: number } = JSON.parse(readFileSync(file, 'utf8'))
    world.spawned = (world.spawned ?? 0) + 1
    if (world.spawned <= (world.spawnLimit ?? 0)) {
      const pid = 8000 + world.spawned
      world.processes.push({ pid, parentPid: Number(rest[rest.indexOf('--pid') + 1]), startedAt: `1343700900000${pid}`, image: `C:\\Apps\\${pid}.exe`, running: true })
      world.orphans = [...(world.orphans ?? []), pid]
    }
    writeFileSync(file, JSON.stringify(world))
  })
}
process.stdout.write(reply)
