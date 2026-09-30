import type { StorageState } from '../../src/protocol/storage-state.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stateFile, statesFolder } from '../../src/protocol/run-folder.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { tempFolder } from '../support/temp-folder.ts'

const state: StorageState = {
  cookies: [{ name: 'session', value: 'abc', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [{ origin: 'http://127.0.0.1:4173', localStorage: [{ name: 'token', value: 'xyz' }] }],
}

describe('saved states', () => {
  test('are written where only this user can read them, read back whole, and never written over', () => {
    const folder = join(tempFolder('store-'), 'run')
    const store = RunStore.create(folder)
    const path = stateFile('signed-in', 'stable')
    store.writeState(path, state)
    assert.deepEqual(store.readState(path), state)
    assert.equal(statSync(store.pathOf(path)).mode & 0o777, 0o600)
    assert.equal(statSync(store.pathOf(statesFolder)).mode & 0o777, 0o700)
    assert.throws(() => store.writeState(path, state), /EEXIST/)
    store.removeStates()
    assert.equal(existsSync(store.pathOf(statesFolder)), false)
    store.close()
  })

  test('a file that is not a saved state is refused', () => {
    const store = RunStore.create(join(tempFolder('store-'), 'run'))
    const path = stateFile('signed-in', 'stable')
    store.writeState(path, state)
    writeFileSync(store.pathOf(path), '{"cookies":[]}')
    assert.throws(() => store.readState(path), /is not a saved state: /)
    store.removeStates()
    store.close()
  })

  test('are removed when the process exits before the run could remove them', async () => {
    const folder = join(tempFolder('store-'), 'run')
    const script = fileURLToPath(new URL('../support/exit-with-state.ts', import.meta.url))
    const child = spawn(process.execPath, ['--conditions=retest-source', script, folder], { stdio: ['ignore', 'pipe', 'inherit'] })
    const [code] = await new Promise<[number | null]>((resolve) => child.once('close', (exit) => resolve([exit])))
    assert.equal(code, 0)
    assert.equal(existsSync(join(folder, 'events.jsonl')), true, 'the run folder was made')
    assert.equal(existsSync(join(folder, statesFolder)), false)
  })

  test('removing states when none were saved does nothing', () => {
    const store = RunStore.create(join(tempFolder('store-'), 'run'))
    store.removeStates()
    store.close()
  })
})
