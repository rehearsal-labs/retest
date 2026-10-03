import type { Environment } from './terminal.ts'

const offValues = new Set(['', '0', 'false'])

/**
 * Whether Retest runs in continuous integration, going by the `CI` variable that most CI services set, GitHub
 * Actions and GitLab CI among them. `0` and `false` mean it is not, as they do for a coding agent's variables.
 *
 * @example isContinuousIntegration({ CI: 'true' }) // true
 */
export function isContinuousIntegration(env: Environment): boolean {
  const setting = env['CI']
  return setting !== undefined && !offValues.has(setting.trim().toLowerCase())
}

/** Why a run in CI refuses `test.only`, and how to run it anyway, as the refusal ends. */
export const onlyInContinuousIntegration = 'CI is set: remove test.only, or pass --allow-only to run it anyway.'
