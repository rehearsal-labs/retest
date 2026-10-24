// A wrapper around the stand-in supervisor for the cases where Windows changes between two runs of retest-supervisor:
// it runs the stand-in, and once, right after the question the world's `race` names was answered, changes the world as
// that race says. `member-reused`: the launch's member 5000 ends just after its job was read, and its pid goes to a
// process of another launch, which starts 7001. `ended-reused`: 5005, just ended by a launch's end, has its pid given to
// a short-lived process of another launch, which starts 7001 and exits before the end's next reading. The arguments are
// the stand-in's path, then what the stand-in itself is given.
import type { StandInWorld } from './process-supervisor-world.ts'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { withWorld } from './process-supervisor-world-lock.ts'

type Race = { verb: string; arg: string; value: string; change: 'member-reused' | 'ended-reused'; launchJob?: string; otherJob?: string }

const [standIn, file, verb, ...rest] = process.argv.slice(2)
if (standIn === undefined || file === undefined || verb === undefined) throw new Error('The wrapper needs the stand-in, its world file and a verb.')
const reply = execFileSync(process.execPath, [standIn, file, verb, ...rest], { encoding: 'utf8' })
withWorld(file, () => {
  const world: StandInWorld & { race?: Race; raced?: boolean } = JSON.parse(readFileSync(file, 'utf8'))
  const race = world.race
  if (race === undefined || world.raced === true || race.verb !== verb || rest[rest.indexOf(`--${race.arg}`) + 1] !== race.value) return
  if (race.change === 'ended-reused' && !reply.includes('"outcome":"terminated"')) return
  const reused = race.change === 'member-reused' ? 5000 : 5005
  const old = world.processes.find((each) => each.pid === reused)
  if (old !== undefined) Object.assign(old, { parentPid: 6000, startedAt: '13437009000009000', image: 'C:\\Apps\\q.exe', running: race.change === 'member-reused' })
  world.processes.push({ pid: 7001, parentPid: reused, startedAt: '13437009000009001', image: 'C:\\Apps\\other-helper.exe', running: true, commandLine: null })
  if (race.launchJob !== undefined) {
    const job = world.jobs[race.launchJob]
    if (job !== undefined) job.members = job.members.filter((pid) => pid !== reused)
  }
  world.jobs[race.otherJob ?? '']?.members.push(reused, 7001)
  world.raced = true
  writeFileSync(file, JSON.stringify(world))
})
process.stdout.write(reply)
