import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// How long each way of loading TypeScript takes to start a one-test file, measured when Retest chose its loader.
// Each argument names a Retest command line to time `retest list` with, as name=path to its main.js or main.ts:
//
//   node scripts/measure-loader.ts head=/tmp/retest-head/dist/cli/main.js source=src/cli/main.ts
//
// It writes only under a temporary folder, which it removes, and launches no browser.

const runs = 5
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

type Scenario = { name: string; measure: (cacheFolder: string) => Promise<number> }
type Row = { name: string; cache: 'cold' | 'warm' } & ({ medianMs: number; minMs: number; maxMs: number } | { failure: string })

const files: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({ name: 'loader-timing', private: true, type: 'module' }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'nodenext', baseUrl: '.', paths: { '@helpers/*': ['helpers/*'] } } }),
  'helpers/label.ts': `export function label(value: string): string {\n  return value.trim()\n}\n`,
  'helpers/model.ts': `export enum Status { Open = 'open', Done = 'done' }\nexport class Task {\n  constructor(readonly title: string, public status: Status = Status.Open) {}\n}\n`,
  'tests/plain.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\nimport { label } from '../helpers/label.ts'\n\ntest('loads', async () => {\n  expect(label(' a ')).toBe('a')\n})\n`,
  'tests/everyday.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\nimport { Status, Task } from '@helpers/model'\nimport { label } from '../helpers/label'\n\ntest('loads', async () => {\n  expect(new Task(label(' a ')).status).toBe(Status.Open)\n})\n`,
  'bare/plain.ts': `import { label } from '../helpers/label.ts'\nconst shown: string = label(' a ')\nif (shown !== 'a') process.exit(1)\n`,
  'bare/everyday.ts': `import { Status, Task } from '../helpers/model.ts'\nimport { label } from '../helpers/label.ts'\nif (new Task(label(' a ')).status !== Status.Open) process.exit(1)\n`,
  // The same transformer Node's --experimental-transform-types uses, called from a load hook.
  'hooks/node-transform.mjs': `import { registerHooks, stripTypeScriptTypes } from 'node:module'
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (loaded.format !== 'module-typescript') return loaded
    const source = String(loaded.source)
    try {
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: url }), shortCircuit: true }
    } catch {
      return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceMap: true, sourceUrl: url }), shortCircuit: true }
    }
  },
})
`,
  // TypeScript's transpileModule, resolved from the project as an optional peer would be.
  'hooks/typescript-transpile.mjs': `import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
const typescript = createRequire(new URL('../package.json', import.meta.url))('typescript')
const compilerOptions = { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2024, inlineSourceMap: true, inlineSources: true, verbatimModuleSyntax: false }
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (loaded.format !== 'module-typescript') return loaded
    const output = typescript.transpileModule(String(loaded.source), { compilerOptions, fileName: fileURLToPath(url) })
    return { format: 'module', source: output.outputText, shortCircuit: true }
  },
})
`,
}

const project = mkdtempSync(join(tmpdir(), 'retest-loader-timing-'))
try {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true })
    writeFileSync(join(project, path), text)
  }
  mkdirSync(join(project, 'node_modules/@rehearsal-labs'), { recursive: true })
  symlinkSync(repositoryRoot, join(project, 'node_modules/@rehearsal-labs/retest'), 'dir')
  symlinkSync(join(repositoryRoot, 'node_modules/typescript'), join(project, 'node_modules/typescript'), 'dir')

  const node = (args: readonly string[]) => (cacheFolder: string) => Promise.resolve(timeNode(args, cacheFolder))
  const commandLines = process.argv.slice(2).map((argument) => {
    const [name = '', main = ''] = argument.split('=')
    const leading = main.endsWith('.ts') ? ['--conditions=retest-source'] : []
    return { name, args: [...leading, resolve(main)] }
  })
  // Every bare row gets the same flags, so only the loading route differs between them.
  const same = ['--enable-source-maps', '--disable-warning=ExperimentalWarning']
  const scenarios: Scenario[] = [
    { name: 'node, type stripping, erasable file', measure: node([...same, 'bare/plain.ts']) },
    { name: 'node --experimental-transform-types, enum file', measure: node([...same, '--experimental-transform-types', 'bare/everyday.ts']) },
    { name: 'node, stripTypeScriptTypes hook, erasable file', measure: node([...same, '--import', './hooks/node-transform.mjs', 'bare/plain.ts']) },
    { name: 'node, stripTypeScriptTypes hook, enum file', measure: node([...same, '--import', './hooks/node-transform.mjs', 'bare/everyday.ts']) },
    { name: 'node, typescript 6 transpileModule hook, enum file', measure: node([...same, '--import', './hooks/typescript-transpile.mjs', 'bare/everyday.ts']) },
    ...commandLines.flatMap(({ name, args }) => [
      { name: `retest list (${name}), erasable file`, measure: node([...args, 'list', 'tests/plain.retest.ts', '--json']) },
      { name: `retest list (${name}), enum, alias and extensionless file`, measure: node([...args, 'list', 'tests/everyday.retest.ts', '--json']) },
    ]),
  ]
  const rows: Row[] = []
  for (const scenario of scenarios) {
    rows.push(await measure(scenario, 'cold'))
    rows.push(await measure(scenario, 'warm'))
  }
  const [oneMinute = 0] = loadavg()
  process.stdout.write(`${process.version}, ${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} cores, load average ${oneMinute.toFixed(1)} at the start\n\n`)
  process.stdout.write('| Route | Compile cache | Median ms | Min ms | Max ms |\n| --- | --- | --- | --- | --- |\n')
  for (const row of rows) {
    const cells = 'failure' in row ? `fails: ${row.failure.split('\n')[0] ?? ''} | | ` : `${row.medianMs} | ${row.minMs} | ${row.maxMs}`
    process.stdout.write(`| ${row.name} | ${row.cache} | ${cells} |\n`)
  }
} finally {
  rmSync(project, { recursive: true, force: true })
}

// Cold runs each get an empty compile cache; warm runs share one that a first, unmeasured run filled. A route that
// cannot load its file is reported with its error rather than timed.
async function measure(scenario: Scenario, cache: 'cold' | 'warm'): Promise<Row> {
  const shared = join(project, `.cache-${rowsCacheName(scenario.name)}`)
  const times: number[] = []
  try {
    if (cache === 'warm') await scenario.measure(shared)
    for (let run = 0; run < runs; run++) times.push(await scenario.measure(cache === 'cold' ? join(project, `.cache-${rowsCacheName(scenario.name)}-${run}`) : shared))
  } catch (error) {
    return { name: scenario.name, cache, failure: error instanceof Error ? error.message : String(error) }
  }
  const sorted = times.toSorted((a, b) => a - b)
  const round = (value: number | undefined): number => Math.round(value ?? Number.NaN)
  return { name: scenario.name, cache, medianMs: round(sorted[Math.floor(runs / 2)]), minMs: round(sorted[0]), maxMs: round(sorted.at(-1)) }
}

function rowsCacheName(name: string): string {
  return name.replaceAll(/[^a-z0-9]+/g, '-')
}

function timeNode(args: readonly string[], cacheFolder: string): number {
  const started = performance.now()
  const run = spawnSync(process.execPath, args, { cwd: project, env: { ...process.env, NODE_COMPILE_CACHE: cacheFolder }, encoding: 'utf8' })
  const elapsed = performance.now() - started
  if (run.status !== 0) throw new Error(`node ${args.join(' ')} exited ${run.status}: ${run.stderr || run.stdout}`.replaceAll('\n', ' '))
  return elapsed
}
