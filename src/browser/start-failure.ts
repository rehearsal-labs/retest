import type { SandboxSystem, StartAttempt } from './sandbox-system.ts'

/** Why a browser stopped before it answered, and how to fix it. */
export type StartFailureExplanation = {
  /** The cause and its fix, in sentences. */
  readonly text: string
  /** Shell commands that make the fix, for a message to end with, one to a line, so they can be copied as they are. */
  readonly commands: readonly string[]
}

type Cause = { pattern: RegExp; explain: (match: RegExpExecArray, attempt: StartAttempt) => StartFailureExplanation }

const sandboxRefused =
  "Chrome's sandbox could not start, because this system does not let the browser create user namespaces. " +
  'Retest keeps the sandbox on, so allow them: in Docker, with a seccomp profile that permits them; ' +
  'on Ubuntu 23.10 or later, with an AppArmor profile for the browser.'

// Causes Chrome states in its own words when it stops before it answers. Retest never passes --no-sandbox, so a
// sandbox that cannot start is fixed in the system, not by switching the sandbox off.
const causes: readonly Cause[] = [
  {
    pattern: /Running as root without --no-sandbox is not supported/,
    explain: () => words('Chrome does not start its sandbox as root, and Retest keeps the sandbox on. Run Retest as a user other than root.'),
  },
  {
    // "No usable sandbox!" when user namespaces are refused and no setuid helper is installed; "Failed to move to
    // new namespace" when the setuid helper is refused them too.
    pattern: /No usable sandbox!|Failed to move to new namespace/,
    explain: (_match, attempt) => (appArmorDecides(attempt.system) ? appArmorProfile(attempt) : words(sandboxRefused)),
  },
  {
    pattern: /error while loading shared libraries: ([^:\s]+)/,
    explain: (match) => words(`The browser cannot load the system library ${match[1] ?? ''}. Install the system libraries the browser needs.`),
  },
]

/**
 * Why a browser stopped before it answered, with the fix, when its output names a cause Chrome states itself.
 * Anything else has no explanation here. A sandbox refused on a system where AppArmor decides which programs may create
 * user namespaces gets the commands that give the browser's own file a profile that allows them.
 *
 * @example explainStartFailure('Running as root without --no-sandbox is not supported.', attempt)?.text // 'Chrome does not start its sandbox as root, ...'
 */
export function explainStartFailure(output: string, attempt: StartAttempt): StartFailureExplanation | undefined {
  for (const { pattern, explain } of causes) {
    const match = pattern.exec(output)
    if (match !== null) return explain(match, attempt)
  }
  return undefined
}

/**
 * An explanation's commands as the last lines of a message, each on a line of its own, or nothing when it has none.
 *
 * @example commandLines({ text: 'Load it.', commands: ['sudo apparmor_parser -r /etc/apparmor.d/opt.chrome'] }) // '\nsudo apparmor_parser -r /etc/apparmor.d/opt.chrome'
 */
export function commandLines(explanation: StartFailureExplanation | undefined): string {
  return explanation === undefined || explanation.commands.length === 0 ? '' : `\n${explanation.commands.join('\n')}`
}

function words(text: string): StartFailureExplanation {
  return { text, commands: [] }
}

// Ubuntu's restriction holds back only unconfined programs, and a browser stays as unconfined as the Retest that starts
// it until a profile names its file. A container keeps the seccomp advice: there the commands would name the
// container's own file, and run inside a system that loads no AppArmor profiles.
function appArmorDecides(system: SandboxSystem): boolean {
  return system.userNamespaceRestriction === '1' && system.appArmorLabel === 'unconfined' && !system.container
}

// Letters, digits and . _ + @ - are the characters neither AppArmor reads as a pattern nor the shell as syntax, so a
// path made of them is written into the profile and the commands as it is.
const nameablePath = /^\/[A-Za-z0-9._+@/-]*$/
const fileNameLimit = 255
// The profile files AppArmor's loader passes over when it loads /etc/apparmor.d at boot: hidden ones, README, and
// these endings (_aa_is_blacklisted in libraries/libapparmor/src/private.c).
const skippedProfileFile = /^\.|^README$|\.(dpkg-new|dpkg-old|dpkg-dist|dpkg-bak|dpkg-remove|pacsave|pacnew|rpmnew|rpmsave|orig|rej)$/

const restricted =
  "Chrome's sandbox could not start, because this system lets a program create user namespaces only when an AppArmor " +
  'profile allows it, as Ubuntu 23.10 and later do. Retest keeps the sandbox on, so give the browser a profile that allows them'

// The profile is the one Chromium documents for its developer builds (docs/security/apparmor-userns-restrictions.md),
// attached to this one file: unconfined, as the browser was, with user namespaces allowed. Its file is named after the
// browser's, as AppArmor's tools name one, so two browsers never share a profile.
function appArmorProfile({ executable, file }: StartAttempt): StartFailureExplanation {
  const profileName = file.slice(1).replaceAll('/', '.')
  if (!nameablePath.test(file) || profileName.length > fileNameLimit || skippedProfileFile.test(profileName)) {
    return words(
      `${restricted}. Retest gives the commands only for a path it can write into a profile and a file name as it is, ` +
        `so write a profile for ${file} by hand: one that names that path and holds the rule "userns,". Load it with sudo apparmor_parser -r.`,
    )
  }
  const profileFile = `/etc/apparmor.d/${profileName}`
  const lines = ['abi <abi/4.0>,', 'include <tunables/global>', '', `${file} flags=(unconfined) {`, '  userns,', '}']
  const linked = file === executable ? '' : `, the file ${executable} links to,`
  return {
    text: `${restricted}: the two commands below write one for ${file}${linked} and load it.`,
    commands: [
      `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')} | sudo tee ${profileFile} > /dev/null`,
      `sudo apparmor_parser -r ${profileFile}`,
    ],
  }
}
