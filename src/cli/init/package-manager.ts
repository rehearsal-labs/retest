import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** How a project's package manager installs development dependencies, runs a binary and runs a script. */
export type PackageManager = { name: PackageManagerName; addDev: string; exec: string; runScript: string }

const managers: Readonly<Record<PackageManagerName, PackageManager>> = {
  npm: { name: 'npm', addDev: 'npm i -D', exec: 'npx', runScript: 'npm run' },
  pnpm: { name: 'pnpm', addDev: 'pnpm add -D', exec: 'pnpm exec', runScript: 'pnpm' },
  yarn: { name: 'yarn', addDev: 'yarn add -D', exec: 'yarn', runScript: 'yarn' },
  bun: { name: 'bun', addDev: 'bun add -d', exec: 'bunx', runScript: 'bun run' },
}

const lockFiles: readonly [string, PackageManagerName][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

/**
 * The package manager a project uses: the one `packageManager` in package.json names, else the one whose lock
 * file is in the folder, else npm.
 *
 * @example detectPackageManager('/work', 'pnpm@10.4.0').addDev // 'pnpm add -D'
 */
export function detectPackageManager(folder: string, declared: string | undefined): PackageManager {
  const named = declared?.split('@')[0]
  const fromField = managerNamed(named)
  if (fromField !== undefined) return fromField
  const found = lockFiles.find(([file]) => existsSync(join(folder, file)))
  return managers[found?.[1] ?? 'npm']
}

function managerNamed(name: string | undefined): PackageManager | undefined {
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? managers[name] : undefined
}
