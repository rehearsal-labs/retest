type Cause = { pattern: RegExp; explain: (match: RegExpExecArray) => string }

// Causes Chrome states in its own words when it stops before it answers. Retest never passes --no-sandbox, so a
// sandbox that cannot start is fixed in the system, not by switching the sandbox off.
const causes: readonly Cause[] = [
  {
    pattern: /Running as root without --no-sandbox is not supported/,
    explain: () => 'Chrome does not start its sandbox as root, and Retest keeps the sandbox on. Run Retest as a user other than root.',
  },
  {
    // "No usable sandbox!" when user namespaces are refused and no setuid helper is installed; "Failed to move to
    // new namespace" when the setuid helper is refused them too.
    pattern: /No usable sandbox!|Failed to move to new namespace/,
    explain: () =>
      "Chrome's sandbox could not start, because this system does not let the browser create user namespaces. " +
      'Retest keeps the sandbox on, so allow them: in Docker, with a seccomp profile that permits them; ' +
      'on Ubuntu 23.10 or later, with an AppArmor profile for the browser.',
  },
  {
    pattern: /error while loading shared libraries: ([^:\s]+)/,
    explain: (match) => `The browser cannot load the system library ${match[1] ?? ''}. Install the system libraries the browser needs.`,
  },
]

/**
 * Why a browser stopped before it answered, with the fix, when its output names a cause Chrome states itself.
 * Anything else has no explanation here.
 *
 * @example explainStartFailure('Running as root without --no-sandbox is not supported.') // 'Chrome does not start its sandbox as root, ...'
 */
export function explainStartFailure(output: string): string | undefined {
  for (const { pattern, explain } of causes) {
    const match = pattern.exec(output)
    if (match !== null) return explain(match)
  }
  return undefined
}
