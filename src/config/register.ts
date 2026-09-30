import type { TouchDeviceName } from './devices.ts'
import type { RetestConfig } from './types.ts'

declare const retestTypeError: unique symbol

/** A type that stands in for a mistake. Its message says what to write instead. */
export interface RetestTypeError<Message extends string> {
  readonly [retestTypeError]: Message
}

/**
 * Where a project registers its config, once, in `retest.config.ts`, so every test file's types see its apps,
 * secrets, test ids, tags and states.
 *
 * @example declare module '@rehearsal-labs/retest' { interface Register { config: typeof config } }
 */
export interface Register {}

/** The registered config's type, or never when no config is registered. */
export type RegisteredConfig = Register extends { readonly config: infer Config extends RetestConfig } ? Config : never

export type IsRegistered = [RegisteredConfig] extends [never] ? false : true

/** What declaring `apps` or `state` gives before a config is registered. */
export type Unregistered =
  RetestTypeError<'Register your config: declare module "@rehearsal-labs/retest" { interface Register { config: typeof config } }'>

/** `T` once a config is registered; before that, the error that says how to register one. */
export type RequiresConfig<T> = IsRegistered extends true ? T : Unregistered

type Config = RegisteredConfig

/** The registered config's app names; never before a config is registered. */
export type AppName = IsRegistered extends true ? keyof Config['apps'] & string : never

/** The app `page` is: `defaultApp`, or the only app. Never when several apps leave it unnamed, or before registering. */
export type DefaultAppName = IsRegistered extends true
  ? Config extends { readonly defaultApp: infer Name extends string }
    ? Name & AppName
    : OnlyMember<AppName>
  : never

/** The config's tags, or any string when it lists none or none is registered. */
export type TagName = IsRegistered extends true ? ListedNames<Config, 'tags'> : string

/** The config's state names, or any string when it lists none; never before a config is registered. */
export type StateName = IsRegistered extends true ? ListedNames<Config, 'states'> : never

/** The config's secret names, or never when it declares none; any string before a config is registered. */
export type SecretName = IsRegistered extends true
  ? Config extends { readonly secrets: infer Secrets extends object }
    ? keyof Secrets & string
    : never
  : string

/**
 * The test ids `getByTestId` accepts: the config's `testIds`, or any string when it has none or none is
 * registered. `testIds` must keep literal types, as a constant declared `as const` does.
 */
export type TestIdValue = IsRegistered extends true
  ? Config extends { readonly testIds: infer Ids }
    ? Ids extends readonly string[]
      ? Ids[number]
      : Ids extends Readonly<Record<string, string>>
        ? Ids[keyof Ids]
        : string
    : string
  : string

/**
 * True when every target of the app emulates a touch screen, a named device or `touch: true`, so its handle
 * has `tap()`. False when any target has no touch screen.
 */
export type AppHasTouch<Name extends AppName> = [AppTargets<Config['apps'][Name]>] extends [never]
  ? false
  : false extends TargetHasTouch<AppTargets<Config['apps'][Name]>>
    ? false
    : true

type ListedNames<Of, Key extends string> = Of extends { readonly [K in Key]: readonly (infer Name extends string)[] } ? Name : string

type AppTargets<Entry> = Entry extends { readonly targets: infer Targets } ? Targets[keyof Targets] : Entry

type TargetHasTouch<Target> = Target extends { readonly emulate: TouchDeviceName | { readonly touch: true } } ? true : false

type OnlyMember<Union, All = Union> = Union extends unknown ? ([All] extends [Union] ? Union : never) : never
