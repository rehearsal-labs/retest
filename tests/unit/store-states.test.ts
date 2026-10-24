import type { StorageState } from '../../src/protocol/storage-state.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { stateFile, statesFolder } from '../../src/protocol/run-folder.ts'
import { currentUserSid } from '../../src/shared/private-file.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { unixOnly, windowsOnly } from '../support/platform-skip.ts'
import { tempFolder } from '../support/temp-folder.ts'

const state: StorageState = {
  cookies: [{ name: 'session', value: 'abc', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [{ origin: 'http://127.0.0.1:4173', localStorage: [{ name: 'token', value: 'xyz' }] }],
}

// A file's access list read back from icacls, in SDDL: its flags, and each entry's kind, flags, rights and SID.
function accessList(path: string): { protectedList: boolean; entries: string[][]; sddl: string } {
  const saved = join(tempFolder('acl-'), 'acl.txt')
  execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path, '/save', saved])
  const sddl = readFileSync(saved, 'utf16le').split(/\r?\n/)[1] ?? ''
  return { protectedList: /^D:PA?I?\(/.test(sddl), entries: [...sddl.matchAll(/\(([^)]*)\)/g)].map((match) => (match[1] ?? '').split(';')), sddl }
}

describe('saved states', () => {
  test('are written where only this user can read them', { skip: unixOnly('Windows keeps a file to its user by its access list, which the next case reads') }, async () => {
    const store = RunStore.create(join(tempFolder('store-'), 'run'))
    const path = stateFile('signed-in', 'stable')
    await store.writeState(path, state)
    assert.equal(statSync(store.pathOf(path)).mode & 0o777, 0o600)
    assert.equal(statSync(store.pathOf(statesFolder)).mode & 0o777, 0o700)
    store.removeStates()
    store.close()
  })

  // On Windows a new folder takes its parent's access list, and a folder under C:\ gives every local user read; this
  // one's parent is made to give it. The states folder is read back from icacls in SDDL before its file: it is
  // protected, holds nothing it inherited, and names the user, with full control passed on to what it holds, and, as a
  // fresh folder's own entries may, the system and the administrators, as root reads on Unix. The state inherits only
  // those.
  test('on Windows are kept to this user: the folder inherits nothing, and its state no one but the user, the system and administrators', { skip: windowsOnly('the access list of a file is read on Windows') }, async () => {
    const parent = tempFolder('store-')
    execFileSync(join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe'), [parent, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
    const store = RunStore.create(join(parent, 'run'))
    const path = stateFile('signed-in', 'stable')
    await store.writeState(path, state)
    const user = await currentUserSid()
    const isUser = (sid: string): boolean => sid === user || (sid === 'LA' && user.endsWith('-500'))
    const allowed = (sid: string): boolean => isUser(sid) || sid === 'SY' || sid === 'BA'
    const folder = accessList(store.pathOf(statesFolder))
    assert.ok(folder.protectedList, `the folder's list is protected from inheritance: ${folder.sddl}`)
    assert.ok(folder.entries.every(([kind, flags = '']) => kind === 'A' && !flags.includes('ID')), folder.sddl)
    assert.ok(folder.entries.every(([, , , , , sid = '']) => allowed(sid)), folder.sddl)
    assert.ok(folder.entries.some(([, flags = '', rights, , , sid = '']) => isUser(sid) && rights === 'FA' && flags.includes('OI') && flags.includes('CI')), folder.sddl)
    const file = accessList(store.pathOf(path))
    assert.ok(file.entries.every(([kind, , , , , sid = '']) => kind === 'A' && allowed(sid)), file.sddl)
    assert.ok(file.entries.some(([, , rights, , , sid = '']) => isUser(sid) && rights === 'FA'), file.sddl)
    assert.deepEqual(store.readState(path), state)
    store.removeStates()
    store.close()
  })

  test('are read back whole, never written over, and removed with their folder', async () => {
    const folder = join(tempFolder('store-'), 'run')
    const store = RunStore.create(folder)
    const path = stateFile('signed-in', 'stable')
    await store.writeState(path, state)
    assert.deepEqual(store.readState(path), state)
    await assert.rejects(store.writeState(path, state), /EEXIST/)
    store.removeStates()
    assert.equal(existsSync(store.pathOf(statesFolder)), false)
    await store.writeState(path, state)
    assert.deepEqual(store.readState(path), state, 'a state saved after the folder was removed makes it again')
    store.removeStates()
    store.close()
  })

  // A link put where a state is to be written is never followed: the state is made exclusively and written through the
  // descriptor that made it, so the file the link names stays as it was.
  test('never write through a link put in their place', async () => {
    const folder = join(tempFolder('store-'), 'run')
    const store = RunStore.create(folder)
    await store.writeState(stateFile('first', 'stable'), state)
    const outside = join(folder, 'outside.json')
    writeFileSync(outside, '', { mode: 0o644 })
    const path = stateFile('signed-in', 'stable')
    symlinkSync(outside, store.pathOf(path))
    await assert.rejects(store.writeState(path, state), /EEXIST/)
    assert.equal(readFileSync(outside, 'utf8'), '', 'the file the link names holds no state')
    store.removeStates()
    store.close()
  })

  test('a states folder that was there before the run saved one is refused', async () => {
    const folder = join(tempFolder('store-'), 'run')
    const store = RunStore.create(folder)
    mkdirSync(store.pathOf(statesFolder))
    await assert.rejects(store.writeState(stateFile('signed-in', 'stable'), state), /EEXIST/)
    store.removeStates()
    store.close()
  })

  // The folder could not be kept private and could not be removed either: the first failure is kept, with what was
  // left. The stand-in for the access-list step fails it and holds the folder so it cannot go.
  test('a folder that cannot be kept private keeps that failure and names the folder it left', async () => {
    const folder = join(tempFolder('store-'), 'run')
    const script = fileURLToPath(new URL('../support/save-state-failing.ts', import.meta.url))
    const hooks = new URL('../support/private-file-fails-hooks.ts', import.meta.url).href
    const child = spawn(process.execPath, ['--conditions=retest-source', `--import=${hooks}`, script, folder], { stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    const [code] = await new Promise<[number | null]>((resolve) => child.once('close', (exit) => resolve([exit])))
    assert.equal(code, 0, stdout)
    const reported: unknown = JSON.parse(stdout)
    assert.ok(typeof reported === 'object' && reported !== null && 'message' in reported && 'detail' in reported, stdout)
    assert.equal(reported.message, 'its folder could not be kept to this user alone.')
    assert.match(String(reported.detail), /^icacls\.exe ended with exit code 5: Access is denied\.; .*states is still there: /)
  })

  test('a file that is not a saved state is refused', async () => {
    const store = RunStore.create(join(tempFolder('store-'), 'run'))
    const path = stateFile('signed-in', 'stable')
    await store.writeState(path, state)
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
