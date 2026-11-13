import { readFile, realpath } from 'node:fs/promises'

/**
 * What Retest read of the system a browser failed to start on, to tell who refused its sandbox the user namespaces it
 * needs. A fact Retest could not read is undefined, and advice never rests on it.
 */
export type SandboxSystem = {
  /**
   * `kernel.apparmor_restrict_unprivileged_userns` as the kernel states it. `'1'` means AppArmor decides which
   * unconfined programs may create user namespaces, as Ubuntu 23.10 and later ship; a kernel without the setting has
   * no such restriction.
   */
  readonly userNamespaceRestriction: string | undefined
  /**
   * Retest's own AppArmor label, such as `'unconfined'` or `'docker-default (enforce)'`. A browser it starts keeps it
   * unless a profile names the browser's file, so the restriction decides for the browser only when this is
   * `'unconfined'`.
   */
  readonly appArmorLabel: string | undefined
  /** Whether a container's marker file is at the root: `/.dockerenv`, which Docker writes, or Podman's `/run/.containerenv`. */
  readonly container: boolean
}

/** A browser that failed to start, as its start failure is explained. */
export type StartAttempt = {
  /** The path Retest started. */
  readonly executable: string
  /** The same file with every symbolic link resolved, which is the path an AppArmor profile must name. */
  readonly file: string
  readonly system: SandboxSystem
}

/** Reads one of the system's files as text, or undefined when it is not there or cannot be read. */
export type SystemFileReader = (path: string) => Promise<string | undefined>

const restrictionSetting = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
// The AppArmor-only attribute, since Linux 5.8, which another security module stacked beside it cannot answer for.
const labelAttribute = '/proc/self/attr/apparmor/current'
const containerMarkers = ['/.dockerenv', '/run/.containerenv']

/**
 * Reads, on Linux, the three facts a sandbox's advice depends on, from files any user may read. Anywhere else, and
 * for any file that cannot be read, the fact is unknown.
 *
 * @example await readSandboxSystem() // { userNamespaceRestriction: '1', appArmorLabel: 'unconfined', container: false } on Ubuntu 24.04
 */
export async function readSandboxSystem(platform: NodeJS.Platform = process.platform, read: SystemFileReader = readSystemFile): Promise<SandboxSystem> {
  if (platform !== 'linux') return { userNamespaceRestriction: undefined, appArmorLabel: undefined, container: false }
  const [restriction, label, ...markers] = await Promise.all([read(restrictionSetting), read(labelAttribute), ...containerMarkers.map(read)])
  return {
    userNamespaceRestriction: restriction?.trim(),
    // The kernel ends the label with a newline, and some kernels with a NUL as well.
    appArmorLabel: label?.replace(/[\0\s]+$/, ''),
    container: markers.some((marker) => marker !== undefined),
  }
}

/**
 * The browser Retest tried to start, with its file and the system read for its start failure's advice.
 *
 * @example await readStartAttempt('/usr/bin/chromium') // { executable: '/usr/bin/chromium', file: '/usr/lib/chromium/chromium', system }
 */
export async function readStartAttempt(executable: string): Promise<StartAttempt> {
  // A file that can no longer be resolved is named as it was started, which is still the file the kernel was given.
  const [file, system] = await Promise.all([realpath(executable).catch(() => executable), readSandboxSystem()])
  return { executable, file, system }
}

async function readSystemFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}
