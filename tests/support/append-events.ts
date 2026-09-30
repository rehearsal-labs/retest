import { RunStore } from '../../src/store/run-store.ts'

// Appends events until killed, for checking what a killed run leaves behind.

const [folder] = process.argv.slice(2)
if (folder === undefined) throw new Error('Pass the run folder.')
const store = RunStore.create(folder)
const message = 'x'.repeat(900)
let sequence = 0
process.stdout.write('ready\n')
for (;;) {
  store.appendEvent({
    schemaVersion: 1,
    runId: 'killed-run',
    sequence,
    time: new Date().toISOString(),
    elapsedMs: sequence,
    type: 'collection.failed',
    file: 'a.retest.ts',
    failure: { class: 'collection_failed', message },
  })
  sequence++
}
