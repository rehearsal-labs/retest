import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Where Node puts the line and column of a call and of a thrown error in TypeScript that its transformer rewrote,
// probed when Retest chose its loader. Each site is compared with where it is written. Run it from the repository
// root with `node scripts/probe-loader-positions.ts`. It writes only under a temporary folder, which it removes.

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

// Every line holds at most one site. A call site is `helper.mark('label')`, read through util.getCallSites as Retest
// reads the place of an action or a check; an error site is `new Error('label')`, read from the stack as Retest reads
// where an error was thrown. The enum and the parameter properties make the transformer rewrite the whole file.
const probe = [
  "import { getCallSites } from 'node:util'",
  'export const seen: { line: number; column: number; label: string }[] = []',
  'function record(label: string, error: Error): void {',
  "  const [, line = '0', column = '0'] = /:(\\d+):(\\d+)\\)?$/.exec((error.stack ?? '').split('\\n')[1] ?? '') ?? []",
  '  seen.push({ line: Number(line), column: Number(column), label })',
  '}',
  'const helper = {',
  '  mark(label: string): number {',
  '    const site = getCallSites(2)[1]',
  '    seen.push({ line: site?.lineNumber ?? 0, column: site?.columnNumber ?? 0, label })',
  '    return 1',
  '  },',
  '}',
  "export enum Kind { A = 'a', B = 'b' }",
  "enum Computed { A = helper.mark('enum initializer'), B = A + 1 }",
  "namespace Space { export const inner = helper.mark('namespace body') }",
  "class Base { constructor(readonly id: number) { helper.mark('base constructor') } }",
  "class Child extends Base { constructor(private readonly name: string, readonly size = helper.mark('default parameter')) { super(helper.mark('super argument')); helper.mark('after super') } }",
  "class Field { value = helper.mark('field initializer'); constructor(public kind: Kind) { record('error in constructor', new Error('error in constructor')) } }",
  "helper.mark('statement')",
  "const value = helper.mark('declaration')",
  "const nested = Math.max(helper.mark('argument'), 2)",
  "const text = `${helper.mark('template')}`",
  "const arrow = (): number => helper.mark('arrow body')",
  'arrow()',
  'const maybe: typeof helper | undefined = helper',
  "maybe?.mark('optional call')",
  "new Child('x')",
  'new Field(Kind.A)',
  "const object = { key: helper.mark('object value') }",
  "await Promise.resolve(helper.mark('await argument'))",
  "async function later(): Promise<void> { await helper.mark('await in async function') }",
  'await later()',
  "if (value === 1) { helper.mark('inside if') }",
  "const chained = [1].map((n: number) => n + helper.mark('callback'))",
  "record('error statement', new Error('error statement'))",
  "const thrown = ((): Error => { try { throw new Error('thrown error') } catch (error) { return error as Error } })()",
  "record('thrown error', thrown)",
  "const typed = <T,>(given: T): T => { record('error in generic arrow', new Error('error in generic arrow')); return given }",
  'typed<number>(1)',
  "const asserted = (Kind.A as string).length; record('error after as', new Error('error after as'))",
  "const satisfied = { a: asserted } satisfies Record<string, number>; record('error after satisfies', new Error('error after satisfies'))",
  'export const done = [Computed.B, Space.inner, nested, text, object, chained, satisfied]',
]

const folder = realpathSync(mkdtempSync(join(tmpdir(), 'retest-loader-positions-')))
try {
  writeFileSync(join(folder, 'package.json'), '{ "type": "module" }\n')
  writeFileSync(join(folder, 'probe.ts'), `${probe.join('\n')}\n`)
  // The project hooks as a test file's process registers them, under the flags it runs with.
  const runner = [
    `const { useProject } = await import(${JSON.stringify(join(repositoryRoot, 'src/loader/project.ts'))})`,
    `useProject({ folder: ${JSON.stringify(folder)}, entry: ${JSON.stringify(join(folder, 'probe.ts'))} })`,
    `const { seen } = await import(${JSON.stringify(join(folder, 'probe.ts'))})`,
    'process.stdout.write(JSON.stringify(seen))',
  ].join('\n')
  const run = spawnSync(process.execPath, ['--enable-source-maps', '--conditions=retest-source', '--input-type=module', '--eval', runner], { encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`the probe failed: ${run.stderr}`)
  const printed: unknown = JSON.parse(run.stdout)
  const seen = Array.isArray(printed) ? printed.filter(isSite) : []
  if (seen.length === 0) throw new Error(`the probe printed no sites: ${run.stdout}`)
  let exact = 0
  for (const { line, column, label } of seen) {
    const written = probe[line - 1] ?? ''
    const site = written.includes(`new Error('${label}')`) ? `new Error('${label}')` : written.includes('throw new Error') ? 'new Error(' : `mark('${label}')`
    const expected = written.indexOf(site) + 1
    if (expected === column) exact += 1
    process.stdout.write(`${expected === column ? 'exact' : 'moved'}  ${label.padEnd(26)} ${line}:${column}${expected === column ? '' : ` written at ${line}:${expected}`}\n`)
  }
  process.stdout.write(`${exact} of ${seen.length} sites at their written line and column\n`)
} finally {
  rmSync(folder, { recursive: true, force: true })
}

type Site = { line: number; column: number; label: string }

function isSite(value: unknown): value is Site {
  if (typeof value !== 'object' || value === null) return false
  return 'line' in value && typeof value.line === 'number' && 'column' in value && typeof value.column === 'number' && 'label' in value && typeof value.label === 'string'
}
