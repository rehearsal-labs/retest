import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
const compilers = ['node_modules/typescript/bin/tsc', 'node_modules/typescript-7/bin/tsc']
// A registered config applies to its whole program, so each registration is a project of its own.
const projects = [
  relative(root, fileURLToPath(new URL('tsconfig.json', import.meta.url))),
  ...readdirSync(fixtures, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(fixtures, entry.name, 'tsconfig.json')))
    .map((entry) => relative(root, join(fixtures, entry.name, 'tsconfig.json'))),
]

const { markers, malformed } = readMarkers()
let failed = malformed.length > 0
for (const marker of malformed) console.error(`malformed marker ${describe(marker)} ${marker.text}`)

for (const compiler of compilers) {
  const version = runCompiler(compiler, ['--version']).stdout.trim().replace(/^Version /, 'TypeScript ')
  const runs = projects.map((project) => {
    const run = runCompiler(compiler, ['-p', project, '--pretty', 'false'])
    return { project, run, ...parseDiagnostics(run.stdout, (file) => resolve(root, file)) }
  })
  const diagnostics = runs.flatMap((entry) => entry.diagnostics)
  const { unexpected, unused } = matchDiagnostics(diagnostics, markers)
  const problems = [
    ...unexpected.map((diagnostic) => `unexpected ${describe(diagnostic)} ${diagnostic.code} ${diagnostic.message}`),
    ...unused.map((marker) => `unused ${describe(marker)} ${marker.code} ${marker.fragment}`),
    ...runs.flatMap(({ project, run, diagnostics: found, unread }) => [
      ...unread.map((line) => `unread output from ${project}: ${line}`),
      ...(run.stderr.trim() === '' ? [] : [`stderr from ${project}: ${run.stderr.trim()}`]),
      ...(run.status !== 0 && found.length === 0 ? [`${project} exited with ${run.status} and reported no errors`] : []),
    ]),
  ]
  if (problems.length === 0) {
    console.log(`${version}: ${diagnostics.length} expected errors matched ${markers.length} markers in ${projects.length} projects`)
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
