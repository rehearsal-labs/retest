import { writeSync } from 'node:fs'

writeSync(1, `pid ${process.pid}\n`)
for (;;) {
  // Never ends: collection must be stopped from outside.
}
