import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  matchDiagnostics,
  parseDiagnostics,
  parseMarkers,
  type Diagnostic,
  type MalformedMarker,
  type Marker,
} from './diagnostics.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixtures = fileURLToPath(new URL('fixtures/', import.meta.url))
const project = relative(root, fileURLToPath(new URL('tsconfig.json', import.meta.url)))
const compilers = ['node_modules/typescript/bin/tsc', 'node_modules/typescript-7/bin/tsc']

const { markers, malformed } = readMarkers()
let failed = malformed.length > 0
for (const marker of malformed) console.error(`malformed marker ${describe(marker)} ${marker.text}`)

for (const compiler of compilers) {
  const version = runCompiler(compiler, ['--version']).stdout.trim().replace(/^Version /, 'TypeScript ')
  const run = runCompiler(compiler, ['-p', project, '--pretty', 'false'])
  const { diagnostics, unread } = parseDiagnostics(run.stdout, (file) => resolve(root, file))
  const { unexpected, unused } = matchDiagnostics(diagnostics, markers)
  const problems = [
    ...unexpected.map((diagnostic) => `unexpected ${describe(diagnostic)} ${diagnostic.code} ${diagnostic.message}`),
    ...unused.map((marker) => `unused ${describe(marker)} ${marker.code} ${marker.fragment}`),
    ...unread.map((line) => `unread output: ${line}`),
    ...(run.stderr.trim() === '' ? [] : [`stderr: ${run.stderr.trim()}`]),
    ...(run.status !== 0 && diagnostics.length === 0 ? [`exited with ${run.status} and reported no errors`] : []),
  ]
  if (problems.length === 0) {
    console.log(`${version}: ${diagnostics.length} expected errors matched ${markers.length} markers`)
    continue
  }
  failed = true
  console.error(`${version}:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
}

process.exitCode = failed ? 1 : 0

function readMarkers(): { markers: Marker[]; malformed: MalformedMarker[] } {
  const files = readdirSync(fixtures, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'))
  if (files.length === 0) throw new Error(`No fixtures found in ${fixtures}.`)
  const found = files.map((file) => parseMarkers(join(fixtures, file), readFileSync(join(fixtures, file), 'utf8')))
  return { markers: found.flatMap((entry) => entry.markers), malformed: found.flatMap((entry) => entry.malformed) }
}

function runCompiler(compiler: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [compiler, ...args], { cwd: root, encoding: 'utf8' })
  if (run.error) throw run.error
  if (run.signal) throw new Error(`${compiler} stopped on ${run.signal}.`)
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

function describe(position: Diagnostic | Marker | MalformedMarker): string {
  return `${relative(root, position.file)}:${position.line}`
}
