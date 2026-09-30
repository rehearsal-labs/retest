import type { AppName, RequiresConfig, RetestTypeError, StateName, TagName } from '../config/register.ts'

// A state option must not infer app names: from a string, a mapped type would infer the string's own keys. And
// without apps, `Partial<Record<never, StateName>>` would be `{}`, which takes any string.
type StateOption<Names extends AppName> = [Names] extends [never] ? StateName : StateName | Partial<Record<NoInfer<Names>, StateName>>

/**
 * Options a `test.describe` block passes down to the tests inside it: the apps they use, their tags, and the
 * saved sign-in state they start from.
 */
export type DescribeOptions<Names extends AppName = never, Inherited extends AppName = never> = {
  readonly apps?: RequiresConfig<readonly [Names, ...Names[]]> | undefined
  readonly tags?: readonly TagName[] | undefined
  readonly state?: RequiresConfig<StateOption<Names | Inherited>> | undefined
}

/**
 * Options for one test: `apps` it uses, `tags` that `--tag` selects it by, the saved `state` it starts from,
 * one name or one per app, and its own `timeout` in milliseconds.
 */
export interface TestOptions<Names extends AppName = never, Inherited extends AppName = never> extends DescribeOptions<Names, Inherited> {
  readonly timeout?: number | undefined
}

/** Options for a setup: the one app it signs in with, and its own `timeout` in milliseconds. */
export type SetupOptions<Name extends AppName = never> = {
  readonly apps?: RequiresConfig<readonly [Name, ...RetestTypeError<'A setup signs in with one app.'>[]]> | undefined
  readonly timeout?: number | undefined
}
