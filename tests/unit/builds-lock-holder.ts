import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { takeInstallLock } from '../../src/cli/install/lock.ts'

// An installer stand-in in a process of its own, for the install lock tests.
//
// `hold <lock>`: takes the lock, prints `held`, keeps it until its input closes, then lets it go and prints
// `released`; a refusal prints `refused` and the message.
//
// `race <lock> <log> <holdMs> <budgetMs>`: tries the lock until it holds it or the budget runs out, writing each
// refusal, then `enter` and `leave` lines with the time around holding it for `holdMs`, to the log.
//
// `try <lock>`: tries the lock once, prints `held` and lets it go, or prints `refused` and the message.

const [mode, path = '', log = '', holdMs = '100', budgetMs = '8000'] = process.argv.slice(2)

if (mode === 'hold') {
  const lock = await takeInstallLock(path)
  if (!lock.ok) {
    process.stdout.write(`refused ${lock.message}\n`)
    process.exit(0)
  }
  process.stdout.write('held\n')
  process.stdin.resume()
  await new Promise<void>((resolve) => process.stdin.once('end', resolve))
  await lock.release()
  process.stdout.write('released\n')
} else if (mode === 'race') {
  const deadline = Date.now() + Number(budgetMs)
  for (;;) {
    const lock = await takeInstallLock(path)
    if (lock.ok) {
      appendFileSync(log, `enter ${process.pid} ${now()}\n`)
      await sleep(Number(holdMs))
      appendFileSync(log, `leave ${process.pid} ${now()}\n`)
      await lock.release()
      break
    }
    appendFileSync(log, `refused ${process.pid} ${JSON.stringify(lock.message)}\n`)
    if (Date.now() > deadline) break
    await sleep(10 + Math.random() * 30)
  }
} else if (mode === 'try') {
  const lock = await takeInstallLock(path)
  if (lock.ok) {
    process.stdout.write('held\n')
    await lock.release()
  } else process.stdout.write(`refused ${lock.message}\n`)
} else {
  process.stderr.write(`Unknown mode ${mode ?? ''}.\n`)
  process.exit(2)
}

// The time in milliseconds with a fraction, on a clock every process on the machine shares.
function now(): string {
  return (performance.timeOrigin + performance.now()).toFixed(3)
}
