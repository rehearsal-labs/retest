import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isRecord, readArray, readNumber } from './json.ts'
import { assertSucceeded, runProgram } from './programs.ts'

test('native observer CPU units and descendant discovery agree with independent Node readings', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-observer-check-'))
  try {
    const output = join(folder, 'own.json')
    const script = `const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)']);
const memory = Buffer.alloc(16 * 1024 * 1024, 7);
const start = performance.now();
while (performance.now() - start < 400) Math.sqrt(Math.random());
child.on('close', () => setTimeout(() => {
  writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, childPid: child.pid, memory: memory[0], ...process.resourceUsage() }));
}, 100));`
    const child = spawn(process.execPath, ['-e', script, output], { stdio: ['ignore', 'pipe', 'pipe'] })
    assert.ok(child.pid)
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)) })
    const observed = await runProgram('/tmp/retest-recording-resource', [String(child.pid), '10000'], { cwd: folder, timeoutMs: 15000 })
    assert.equal(await closed, 0, stderr)
    assertSucceeded(observed, 'observer calibration')
    const native: unknown = JSON.parse(observed.stdout)
    const own: unknown = JSON.parse(await readFile(output, 'utf8'))
    assert.ok(isRecord(native) && isRecord(own))
    const records = readArray(native, 'processes')
    const root = records.find(value => isRecord(value) && readNumber(value, 'pid') === readNumber(own, 'pid'))
    assert.ok(isRecord(root))
    const sampledCpu = (readNumber(root, 'userCpuMs') ?? 0) + (readNumber(root, 'systemCpuMs') ?? 0)
    const independentCpu = ((readNumber(own, 'userCPUTime') ?? 0) + (readNumber(own, 'systemCPUTime') ?? 0)) / 1000
    assert.ok(independentCpu > 300)
    assert.ok(sampledCpu > independentCpu * 0.85 && sampledCpu < independentCpu * 1.15, `${sampledCpu} native ms vs ${independentCpu} independent ms`)
    assert.ok(records.some(value => isRecord(value) && readNumber(value, 'pid') === readNumber(own, 'childPid')), 'the launched child is observed, not lost to a byte/count conversion')
    const rss = readNumber(root, 'sampledPeakRssBytes') ?? 0
    assert.ok(rss > 16 * 1024 * 1024)
    assert.ok(rss <= (readNumber(own, 'maxRSS') ?? 0) * 1024 + 8 * 1024 * 1024)
    process.stdout.write(`calibration: ${sampledCpu.toFixed(3)} native CPU ms, ${independentCpu.toFixed(3)} Node CPU ms; ${records.length} processes observed\n`)
  } finally { await rm(folder, { recursive: true, force: true }) }
})
