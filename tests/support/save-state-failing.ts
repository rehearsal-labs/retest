import { stateFile } from '../../src/protocol/run-folder.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { release } from './private-file-fails.ts'

// Saves a state while the stand-in for the access-list step fails it (private-file-fails-hooks.ts), and prints the
// failure's message and detail as JSON. Started by tests/unit/store-states.test.ts.

const [folder] = process.argv.slice(2)
if (folder === undefined) throw new Error('Pass the run folder.')
const store = RunStore.create(folder)
try {
  await store.writeState(stateFile('signed-in', 'stable'), { cookies: [], origins: [] })
  process.stdout.write(JSON.stringify({ saved: true }))
} catch (error) {
  const detail = typeof error === 'object' && error !== null && 'detail' in error ? error.detail : undefined
  process.stdout.write(JSON.stringify({ message: error instanceof Error ? error.message : String(error), detail }))
} finally {
  await release()
  store.removeStates()
  store.close()
}
