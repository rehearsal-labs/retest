import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun'

/** How a project's package manager runs a binary and runs a script. */
export type PackageManager = { name: PackageManagerName; exec: string; runScript: string }

/** What tells a project's package manager: its folder, its `packageManager` field and `npm_config_user_agent`. */
export type DetectOptions = { folder: string; declared: string | undefined; userAgent: string | undefined }

/** How a package manager's install starts: a program and its arguments, or, through the shell, the whole line. */
export type InstallCommand = { readonly text: string; readonly file: string; readonly args: readonly string[]; readonly shell: boolean }

const managers: Readonly<Record<PackageManagerName, PackageManager>> = {
  npm: { name: 'npm', exec: 'npx', runScript: 'npm run' },
  pnpm: { name: 'pnpm', exec: 'pnpm exec', runScript: 'pnpm' },
  yarn: { name: 'yarn', exec: 'yarn', runScript: 'yarn' },
  bun: { name: 'bun', exec: 'bunx', runScript: 'bun run' },
}

const lockFiles: readonly [string, PackageManagerName][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

/**
 * The package manager a project uses: the one `packageManager` in package.json names, else the one whose lock file is
 * in the folder, else the one that started this command, which npx, pnpm dlx, yarn dlx and bunx name first in
 * `npm_config_user_agent`, else npm.
 *
 * @example detectPackageManager({ folder: '/work', declared: 'pnpm@10.4.0', userAgent: undefined }).exec // 'pnpm exec'
 */
export function detectPackageManager(options: DetectOptions): PackageManager {
  const fromField = managerNamed(options.declared?.split('@')[0])
  if (fromField !== undefined) return fromField
  const found = lockFiles.find(([file]) => existsSync(join(options.folder, file)))
  if (found !== undefined) return managers[found[1]]
  return managerNamed(options.userAgent?.trim().split('/')[0]) ?? managers.npm
}

/**
 * A package manager's plain install, as `platform` starts it. Elsewhere than on Windows the manager is started from
 * PATH, with `install` as its one argument. On Windows npm, pnpm and yarn are batch files, such as `npm.cmd`, which
 * Node starts only through cmd.exe, so there the line goes through the shell: the manager's name and `install`, and
 * nothing a person typed.
 *
 * @example installCommand(manager, 'linux') // { text: 'npm install', file: 'npm', args: ['install'], shell: false }
 */
export function installCommand(manager: PackageManager, platform: NodeJS.Platform): InstallCommand {
  const text = `${manager.name} install`
  if (platform === 'win32') return { text, file: text, args: [], shell: true }
  return { text, file: manager.name, args: ['install'], shell: false }
}

function managerNamed(name: string | undefined): PackageManager | undefined {
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? managers[name] : undefined
}
