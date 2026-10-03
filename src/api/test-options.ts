import type { AppName, LockName, RequiresConfig, RetestTypeError, StateName, TagName } from '../config/register.ts'

// A state option must not infer app names: from a string, a mapped type would infer the string's own keys. And
// without apps, `Partial<Record<never, StateName>>` would be `{}`, which takes any string.
type StateOption<Names extends AppName> = [Names] extends [never] ? StateName : StateName | Partial<Record<NoInfer<Names>, StateName>>

/**
 * Options a `test.describe` block passes down to the tests inside it: the apps they use, their tags, the saved
 * sign-in state they start from, and the locks they hold.
 */
export type DescribeOptions<Names extends AppName = never, Inherited extends AppName = never> = {
  readonly apps?: RequiresConfig<readonly [Names, ...Names[]]> | undefined
  readonly tags?: readonly TagName[] | undefined
  readonly state?: RequiresConfig<StateOption<Names | Inherited>> | undefined
  /**
   * Shared state outside the page that the test needs to itself, such as one inbox or one staging account, by the
   * names the config's `locks` declares. Two tests that hold a common lock never run at the same time.
   */
  readonly locks?: readonly LockName[] | undefined
}

/**
 * Options for one test: `apps` it uses, `tags` that `--tag` selects it by, the saved `state` it starts from,
 * one name or one per app, the `locks` it holds while it runs, and its own `timeout` in milliseconds.
 */
export interface TestOptions<Names extends AppName = never, Inherited extends AppName = never> extends DescribeOptions<Names, Inherited> {
  readonly timeout?: number | undefined
}

/** Options for a setup: the one app it signs in with, and its own `timeout` in milliseconds. */
export type SetupOptions<Name extends AppName = never> = {
  readonly apps?: RequiresConfig<readonly [Name, ...RetestTypeError<'A setup signs in with one app.'>[]]> | undefined
  readonly timeout?: number | undefined
}
