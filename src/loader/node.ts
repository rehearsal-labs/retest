import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The flags a test file's process runs with. Its load hook strips the project's types, and transforms with a source map
 * a module stripping refuses; source maps are on from the start, so a stack and the location of each action and check
 * name the TypeScript line and column. `util.getCallSites` maps locations only under this flag.
 */
export const testProcessFlags: readonly string[] = ['--enable-source-maps']

/** The oldest Node Retest runs on, read from the engines field of its package.json, such as `24.12.0`. */
export const minimumNodeVersion: string = readMinimum()

// An enum and a parameter property: both need the transformer, not just type stripping.
const probeSource = 'enum Probe { Ready = 1 }\nclass Check { constructor(readonly value: Probe) {} }\nexport const value = new Check(Probe.Ready).value\n'
// The module a test file's process transforms TypeScript with: transform.ts from source, transform.js once built.
const transformUrl = new URL(`./transform${extname(fileURLToPath(import.meta.url))}`, import.meta.url).href

/**
 * Whether a Node version is the minimum or later. Both are `major.minor.patch`, as `process.versions.node` gives them.
 *
 * @example meetsMinimum('24.11.1', '24.12.0') // false
 */
export function meetsMinimum(version: string, minimum: string = minimumNodeVersion): boolean {
  const given = versionParts(version)
  const least = versionParts(minimum)
  for (const [index, part] of least.entries()) {
    const other = given[index] ?? 0
    if (other !== part) return other > part
  }
  return true
}

/**
 * Starts Node with the flags of a test file's process, in the environment a run gives it, checks that it loads TypeScript
 * files, and has it transform and run TypeScript that has an enum and a parameter property with the module a test
 * file's process uses. Undefined when it runs, otherwise what Node said.
 *
 * @example probeTransformer(process.env) // undefined
 */
export function probeTransformer(env: Readonly<Record<string, string | undefined>>, timeoutMs = 10_000): string | undefined {
  const script = [
    "if (process.features.typescript === false) throw new Error('Node starts with TypeScript turned off, so it cannot load a .ts file.')",
    `const { transformTypeScript } = await import(${JSON.stringify(transformUrl)})`,
    `const source = transformTypeScript(${JSON.stringify(probeSource)}, 'file:///retest-probe.ts', 'retest-probe.ts')`,
    "const { value } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)",
    'if (value !== 1) throw new Error(`The transformed enum read ${value}, not 1.`)',
  ].join('\n')
  const probe = spawnSync(process.execPath, [...testProcessFlags, '--input-type=module', '--eval', script], { env, encoding: 'utf8', timeout: timeoutMs })
  if (probe.error !== undefined) return probe.error.message
  if (probe.status === 0) return undefined
  // The error's own line, such as "Error: ...", and otherwise the first line Node printed, such as a refused option.
  const lines = probe.stderr.split('\n').map((line) => line.trim())
  const said = lines.find((line) => /^\w*Error\b/.test(line)) ?? lines.find((line) => line !== '')
  return said ?? `Node exited with ${probe.status === null ? `signal ${probe.signal ?? 'unknown'}` : `code ${probe.status}`}.`
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function readMinimum(): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  const engines = typeof manifest === 'object' && manifest !== null && 'engines' in manifest ? manifest.engines : undefined
  const node = typeof engines === 'object' && engines !== null && 'node' in engines ? engines.node : undefined
  const minimum = typeof node === 'string' ? /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(node.trim())?.[1] : undefined
  if (minimum === undefined) throw new Error('The Retest package.json has no engines.node of the form >=major.minor.')
  const [major = '0', minor = '0', patch = '0'] = minimum.split('.')
  return `${major}.${minor}.${patch}`
}
