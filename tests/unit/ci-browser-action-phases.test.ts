import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const probe = fileURLToPath(new URL('./ci-browser-action-phases-probe.ts', import.meta.url))

async function control(mode: string): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'retest-ci-action-phases-'))
  try {
    const child = spawn(process.execPath, [probe, mode], {
      env: { ...process.env, NODE_OPTIONS: '', RETEST_CI_BROWSER_ACTION_PHASE_LOG: mode === 'write-failure' ? folder : join(folder, 'phases.log') },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      killSignal: 'SIGKILL',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(ended.signal, null, stderr)
    assert.equal(ended.code, 0, stderr)
    assert.equal(stdout, '', 'the observer cannot change the CLI stdout')
    assert.equal(stderr, '', 'the observer cannot change the CLI stderr')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

test('CI action observation preserves every original dispatch/send argument and promise', () => control('identity'))
test('CI action observation writes nothing for pass, refusal or non-timeout rejection', () => control('quiet'))
test('CI action timeouts retain final input and known phases while omitting private payloads', () => control('timeout'))
test('CI action observation bounds its event ring and counts omitted records', () => control('ring'))
test('a failed CI action log write changes neither a result nor a rejection', () => control('write-failure'))
