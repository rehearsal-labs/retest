import { arch, cpus, platform, release, totalmem } from 'node:os'
import { runProgram } from './programs.ts'

export type Machine = {
  readonly cpu: string
  readonly cores: number
  readonly memoryGb: number
  readonly platform: string
  readonly release: string
  readonly arch: string
  readonly node: string
}

/** The machine the benchmark ran on, as the report names it. */
export function describeMachine(): Machine {
  const processors = cpus()
  return {
    cpu: processors[0]?.model.trim() ?? 'unknown CPU',
    cores: processors.length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.version,
  }
}

/** What the browser says of itself, such as `Google Chrome 154.0.8037.92`. */
export async function browserVersion(executable: string, cwd: string): Promise<string> {
  const run = await runProgram(executable, ['--version'], { cwd, timeoutMs: 30_000 })
  const line = run.stdout.trim().split('\n')[0] ?? ''
  return line === '' ? 'unknown browser version' : line
}

export type Source = {
  /** The commit the checkout was at. */
  readonly commit: string
  /** Whether the working tree had changes that are not in that commit. */
  readonly dirty: boolean
  /** Whether `npm run build` ran before packing, or dist was taken as found. */
  readonly built: boolean
}

/** The code the packed Retest came from, so a published number can be tied to it. */
export async function describeSource(repositoryRoot: string, built: boolean): Promise<Source> {
  const head = await runProgram('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, timeoutMs: 30_000 })
  const status = await runProgram('git', ['status', '--porcelain'], { cwd: repositoryRoot, timeoutMs: 30_000 })
  if (head.code !== 0 || status.code !== 0) throw new Error(`Could not read the git state of ${repositoryRoot}:\n${head.stderr}${status.stderr}`)
  return { commit: head.stdout.trim(), dirty: status.stdout.trim() !== '', built }
}
