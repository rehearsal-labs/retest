// A stand-in for retest-supervisor, for tests on every platform: the same command line and the same one-line JSON
// replies, answered from a world kept in a JSON file instead of from Windows. The first argument is that file; the rest
// is what retest-supervisor would be given. Each run appends its arguments to the world's `calls`, so a test can count
// what was asked. A world can make one verb refuse, print something that is not a reply, or exit with a code.
import type { StandInJob, StandInProcess, StandInWorld } from './process-supervisor-world.ts'
import { readFileSync, writeFileSync } from 'node:fs'

const [file, verb = '', ...rest] = process.argv.slice(2)
if (file === undefined) throw new Error('The stand-in needs its world file.')
const world: StandInWorld = JSON.parse(readFileSync(file, 'utf8'))
world.calls.push([verb, ...rest])
const values = new Map<string, string>()
for (let index = 0; index < rest.length; index += 2) values.set((rest[index] ?? '').replace(/^--/, ''), rest[index + 1] ?? '')
const number = (name: string): number => Number(values.get(name))
// A refusal about a job, which the supervisor names apart from its sentence.
const about = (job: string, problem: string): Record<string, unknown> => ({ type: 'refused', problem, detail: `Job ${job}.` })
const text = (name: string): string => values.get(name) ?? ''

const answer = ((): Record<string, unknown> => {
  if (world.exit?.[verb] !== undefined) return {}
  const refusal = world.refuse?.[verb]
  if (refusal !== undefined) return typeof refusal === 'string' ? { type: 'refused', problem: refusal } : { type: 'refused', ...refusal }
  const running = (pid: number): StandInProcess | undefined => world.processes.find((entry) => entry.pid === pid && entry.running)
  const identity = (entry: StandInProcess): Record<string, unknown> => ({ pid: entry.pid, parentPid: entry.parentPid, startedAt: entry.startedAt, image: entry.image })
  const jobOf = (name: string): StandInJob | undefined => world.jobs[name]
  const held = (name: string, pid: number): boolean => jobOf(name)?.members.includes(pid) === true
  switch (verb) {
    case 'hold': {
      if (number('runner') !== world.runner) return { type: 'refused', problem: `Process ${number('runner')} did not start this request, so it was not held.` }
      if (jobOf(text('job')) !== undefined) return about(text('job'), 'Another job already has this name, so it was not used.')
      const handle = world.nextHandle
      world.nextHandle += 4
      world.jobs[text('job')] = { members: [world.runner], handle }
      return { type: 'held', job: text('job'), runner: world.runner, handle }
    }
    case 'adopt': {
      // A child that ended is still known by its pid while its parent has not let go of it, and is not put in the job.
      const child = world.processes.find((entry) => entry.pid === number('pid'))
      if (child === undefined) return { type: 'refused', problem: `Process ${number('pid')} is not running, so it was not held.` }
      if (child.parentPid !== number('runner')) return { type: 'refused', problem: `Process ${child.pid} was not started by process ${number('runner')}, so it was not held.` }
      if (jobOf(text('within'))?.members.includes(number('runner')) !== true) return about(text('within'), `Process ${number('runner')} is not held yet, so nothing was held for it.`)
      if (jobOf(text('job')) !== undefined) return about(text('job'), 'Another job already has this name, so it was not used.')
      const members = child.running ? [child.pid] : []
      const late: StandInProcess[] = []
      const parented: StandInProcess[] = []
      let found = true
      while (found) {
        found = false
        for (const entry of world.processes) {
          if (!entry.running || members.includes(entry.pid) || parented.includes(entry) || (entry.parentPid !== child.pid && !members.includes(entry.parentPid))) continue
          if (world.byParent?.includes(entry.pid) === true) parented.push(entry)
          else {
            members.push(entry.pid)
            late.push(entry)
          }
          found = true
        }
      }
      const handle = world.nextHandle
      world.nextHandle += 4
      world.jobs[text('job')] = { members, handle }
      return { type: 'adopted', job: text('job'), handle, root: identity(child), ended: !child.running, late: late.map(identity), byParent: parented.map(identity), unheld: [], complete: true }
    }
    case 'members': {
      const job = jobOf(text('job'))
      if (job === undefined) return about(text('job'), 'Retest no longer holds these processes.')
      // The runner's job holds everything the runner started since it was held, nested jobs included.
      if (job.members.includes(world.runner)) {
        const within = new Set([world.runner])
        let grew = true
        while (grew) {
          grew = false
          for (const entry of world.processes) if (!within.has(entry.pid) && within.has(entry.parentPid)) { within.add(entry.pid); grew = true }
        }
        for (const pid of world.orphans ?? []) within.add(pid)
        return { type: 'members', job: text('job'), processes: [...within].flatMap((pid) => { const entry = running(pid); return entry === undefined ? [] : [identity(entry)] }) }
      }
      return { type: 'members', job: text('job'), processes: job.members.flatMap((pid) => { const entry = running(pid); return entry === undefined ? [] : [identity(entry)] }) }
    }
    case 'process': {
      const entry = running(number('pid'))
      if (entry === undefined) return { type: 'process', process: null, inJob: null }
      return { type: 'process', process: identity(entry), inJob: values.has('job') ? held(text('job'), entry.pid) : null }
    }
    case 'end': {
      const job = jobOf(text('job'))
      if (job === undefined) return about(text('job'), 'Retest no longer holds these processes.')
      if (job.members.includes(number('runner'))) return about(text('job'), 'These processes include Retest itself, so they were not ended.')
      for (const pid of job.members) { const entry = running(pid); if (entry !== undefined) entry.running = false }
      return { type: 'ended', job: text('job') }
    }
    case 'terminate': {
      const entry = running(number('pid'))
      if (entry === undefined) return { type: 'terminated', pid: number('pid'), outcome: 'absent' }
      if (entry.startedAt !== text('started') || !held(text('job'), entry.pid)) return { type: 'terminated', pid: entry.pid, outcome: 'different' }
      entry.running = false
      return { type: 'terminated', pid: entry.pid, outcome: 'terminated' }
    }
    case 'release': {
      const job = jobOf(text('job'))
      if (job === undefined) return about(text('job'), 'Retest no longer holds these processes.')
      if (job.handle !== number('handle')) return about(text('job'), `Handle ${number('handle')} of process ${number('runner')} is another one, so it was left open.`)
      if (job.members.some((pid) => running(pid) !== undefined)) return about(text('job'), 'Processes are still running there, so its handle was kept.')
      Reflect.deleteProperty(world.jobs, text('job'))
      return { type: 'released', job: text('job') }
    }
    case 'strays': {
      if (jobOf(text('job')) === undefined) return about(text('job'), 'Retest no longer holds these processes.')
      const launches = (values.get('launches') ?? '').split(',').filter((name) => name !== '')
      const held = (pid: number): boolean => launches.some((name) => jobOf(name)?.members.includes(pid) === true)
      return { type: 'strays', job: text('job'), processes: (world.orphans ?? []).flatMap((pid) => { const entry = running(pid); return entry === undefined || held(pid) ? [] : [identity(entry)] }) }
    }
    case 'interrupt': {
      const job = jobOf(text('job'))
      if (job === undefined) return about(text('job'), 'Retest no longer holds these processes.')
      if (job.members.includes(number('runner'))) return about(text('job'), 'These processes include Retest itself, so Ctrl+C was not sent.')
      if (world.console === 'shared') return about(text('job'), "These processes share Retest's console, so Ctrl+C was not sent.")
      const live = job.members.filter((pid) => running(pid) !== undefined)
      if (world.console === 'none' || live.length === 0) return about(text('job'), 'None of these processes has a console, so Ctrl+C was not sent.')
      if (world.stopsOnCtrlC === true) for (const pid of live) { const entry = running(pid); if (entry !== undefined) entry.running = false }
      return { type: 'interrupted', job: text('job'), console: live[0], reached: live }
    }
    default:
      return { type: 'refused', problem: `unknown command ${verb}` }
  }
})()

writeFileSync(file, JSON.stringify(world))
const exitCode = world.exit?.[verb]
if (exitCode !== undefined) process.exit(exitCode)
const printed = world.print?.[verb]
// A refusal always carries its detail, null when no Windows call failed.
const reply = answer['type'] === 'refused' && !('detail' in answer) ? { ...answer, detail: null } : answer
process.stdout.write(printed ?? `${JSON.stringify({ schemaVersion: 1, ...reply })}\n`)
