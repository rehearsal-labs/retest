import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { expect, test } from 'retest'

// Its first test lets the run start the next file's process, which it does once a file's first test is over. Its
// second tells the signals server which processes Retest's process has while it runs, and writes down when its own
// process exits; collection's load does neither. pgrep leaves out its own ancestors on macOS, this process among
// them, and finds nothing when Retest's process has no other child.
test('lets the next file start', () => {
  expect(1).toBe(1)
})

test('lists the processes beside it', async () => {
  const order = process.env['SIGNALS_ORDER'] ?? ''
  process.on('exit', () => appendFileSync(order, `exited ${process.pid}\n`))
  const listed = spawnSync('pgrep', ['-P', String(process.ppid)], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line !== '')
  const answer = await fetch(`${process.env['SIGNALS_URL']}/siblings?pids=${listed.join(',')}`)
  expect(await answer.text()).toBe('listed')
})
