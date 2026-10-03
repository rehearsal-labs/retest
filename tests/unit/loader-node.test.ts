import type { NodeFacts } from '../../src/cli/doctor/checks.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { runChecks } from '../../src/cli/doctor/checks.ts'
import { chromium } from '../../src/config/define.ts'
import { meetsMinimum, minimumNodeVersion, probeTransformer, testProcessFlags } from '../../src/loader/node.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { loadedConfig } from './cli-fixtures.ts'

const config = loadedConfig('/work', { apps: { web: chromium({ executablePath: '/fake/chromium' }) } })
const missing = { class: 'setup_failed' as const, message: 'There is no browser at /fake/chromium.' }

// Doctor on one app whose browser is missing, so nothing launches and its line follows Node's.
async function doctorChecks(node: NodeFacts) {
  const checks = await runChecks(config, {
    dependencies: {
      resolveExecutable: () => ({ ok: false, failure: missing, tried: ['/fake/chromium'] }),
      launchBrowser: () => assert.fail('no browser launches'),
      probeReady: () => assert.fail('the app has no address to ask'),
      startAppServer: () => assert.fail('the app has no server'),
      env: { NODE_OPTIONS: '--max-old-space-size=4096' },
      signal: new AbortController().signal,
    },
    timeouts: defaultTimeouts,
    logFolder: '/tmp/retest-doctor-unused',
    node,
  })
  assert.deepEqual(checks.at(-1), { group: 'web', subject: 'chromium()', ok: false, text: missing.message }, 'the target is checked after Node')
  return checks.slice(0, -1)
}

describe('the Node a run needs', () => {
  test('the minimum is the engines field of the package.json, written major.minor.patch', () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    assert.ok(typeof manifest === 'object' && manifest !== null && 'engines' in manifest)
    assert.deepEqual(manifest.engines, { node: '>=24.12' })
    assert.equal(minimumNodeVersion, '24.12.0')
  })

  test('a version meets the minimum when no part of it is lower, read part by part as numbers', () => {
    const table: [string, boolean][] = [
      ['24.12.0', true],
      ['24.12.3', true],
      ['24.13.0', true],
      ['25.0.0', true],
      ['24.11.9', false],
      ['24.2.0', false],
      ['22.20.0', false],
    ]
    for (const [version, meets] of table) assert.equal(meetsMinimum(version, '24.12.0'), meets, version)
  })

  test('test file processes run with source maps and no other flag: no transform flag, and no warning hidden from test code', () => {
    assert.deepEqual(testProcessFlags, ['--enable-source-maps'])
  })

  test('TypeScript loads on this Node as a test file loads it, and a Node that cannot load it says why', () => {
    assert.equal(probeTransformer(process.env), undefined)
    assert.equal(probeTransformer({ ...process.env, NODE_OPTIONS: '--no-such-flag' }), `${process.execPath}: --no-such-flag is not allowed in NODE_OPTIONS`)
    assert.equal(probeTransformer({ ...process.env, NODE_OPTIONS: '--no-experimental-strip-types' }), 'Error: Node starts with TypeScript turned off, so it cannot load a .ts file.')
  })
})

describe('doctor checks Node', () => {
  test('a Node that meets the minimum and starts the transformer adds no line', async () => {
    const asked: unknown[] = []
    const checks = await doctorChecks({ version: '24.12.0', probeTransformer: (env) => void asked.push(env) })
    assert.deepEqual(checks, [])
    assert.deepEqual(asked, [{ NODE_OPTIONS: '--max-old-space-size=4096' }], 'the transformer is started in the environment a run gives')
  })

  test('an older Node fails with the minimum and how to fix it, and the transformer is not asked', async () => {
    const checks = await doctorChecks({ version: '24.11.1', probeTransformer: () => assert.fail('not asked') })
    assert.deepEqual(checks, [
      { group: 'node', subject: 'v24.11.1', ok: false, text: 'Retest needs Node 24.12.0 or later.', fix: 'Install Node 24.12.0 or later, then run npx retest doctor again.' },
    ])
  })

  test('a Node that cannot load TypeScript as a test file does fails with what Node said and where to look', async () => {
    const checks = await doctorChecks({ version: '24.12.0', probeTransformer: () => 'Error: Node starts with TypeScript turned off, so it cannot load a .ts file.' })
    assert.deepEqual(checks, [
      {
        group: 'node',
        subject: 'TypeScript',
        ok: false,
        text: "Node could not load TypeScript as a test file's process loads it: Error: Node starts with TypeScript turned off, so it cannot load a .ts file.",
        fix: "Test files load with Node's own TypeScript transformer. Remove what turns it off, such as --no-experimental-strip-types in NODE_OPTIONS.",
      },
    ])
  })
})
