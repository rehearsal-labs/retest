import type { EvidenceKind } from '../protocol/evaluation.ts'
import type { TouchDeviceName } from './devices.ts'
import type { NativePlatform, RetestConfig } from './types.ts'

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

/**
 * The config's lock names. A registered config that lists no `locks` takes none, so a lock is always declared
 * before a test holds it; before a config is registered, any string.
 */
export type LockName = IsRegistered extends true
  ? Config extends { readonly locks: readonly (infer Name extends string)[] }
    ? Name
    : RetestTypeError<"The config declares no locks. List the lock in the config's locks first, such as locks: ['inbox'].">
  : string

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

/**
 * What an app's targets are: `web` for browsers, `electron` for Electron apps, or the native platform they name. The
 * loader refuses an app whose targets are of more than one kind; its type is then every kind they are.
 */
export type AppKind<Name extends AppName> = TargetKind<AppTargets<Config['apps'][Name]>>

type TargetKind<Target> = Target extends { readonly browser: 'electron' }
  ? 'electron'
  : Target extends { readonly browser: string }
    ? 'web'
    : Target extends { readonly platform: infer Platform extends NativePlatform }
      ? Platform
      : 'web'

/** The config's judge names: any string before a config is registered, never when it declares no judges. */
export type JudgeName = IsRegistered extends true ? (keyof ConfigJudges & string) : string

/** The judge a check that names none uses: `defaultJudge`, or the only judge. Never when there is none to use. */
export type DefaultJudgeName = IsRegistered extends true
  ? Config extends { readonly evaluation: { readonly defaultJudge: infer Name extends string } }
    ? Name & JudgeName
    : OnlyMember<JudgeName>
  : string

/** What a judge takes, from its `accepts`: every kind before a config is registered. */
export type JudgeAccepts<Name extends string> = IsRegistered extends true
  ? Name extends keyof ConfigJudges
    ? ConfigJudges[Name] extends { readonly accepts: readonly (infer Kind extends EvidenceKind)[] }
      ? Kind
      : never
    : never
  : EvidenceKind

type ConfigJudges = Config extends { readonly evaluation: { readonly judges: infer Judges extends object } } ? Judges : {}

type ListedNames<Of, Key extends string> = Of extends { readonly [K in Key]: readonly (infer Name extends string)[] } ? Name : string

// An entry that names a browser or a platform is a target on its own. `chromium()` called with no options takes the
// type of its place in the config, every kind of entry, each still naming its browser, so the name is read first.
type AppTargets<Entry> = Entry extends { readonly browser: string } | { readonly platform: string }
  ? Entry
  : Entry extends { readonly targets: infer Targets }
    ? Targets[keyof Targets]
    : Entry

type TargetHasTouch<Target> = Target extends { readonly emulate: TouchDeviceName | { readonly touch: true } } ? true : false

type OnlyMember<Union, All = Union> = Union extends unknown ? ([All] extends [Union] ? Union : never) : never
