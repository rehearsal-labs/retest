import { stateFile } from '../../src/protocol/run-folder.ts'
import { RunStore } from '../../src/store/run-store.ts'

// Saves a state, then exits without ending the run, as a second Ctrl+C does.

const [folder] = process.argv.slice(2)
if (folder === undefined) throw new Error('Pass the run folder.')
const store = RunStore.create(folder)
store.writeState(stateFile('signed-in', 'stable'), { cookies: [], origins: [] })
process.stdout.write('saved\n', () => process.exit(0))
