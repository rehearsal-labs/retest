import { writeSync } from 'node:fs'

writeSync(1, `pid ${process.pid}\n`)
for (;;) {
  // Never ends, so only the collection budget stops this file.
}
