import type { Page } from '@rehearsal-labs/retest'
import { test } from '@rehearsal-labs/retest'

// The conformance configs are not registered: a registration would apply to every file of the repository's own
// TypeScript program. Without one, `state` and `apps` do not type-check, so the tests that use them call `test`
// through the forms below, typed as a registered config would type them. The run loads the folder's config and
// checks every name against it, as it checks any test's.

type PageBody = (context: { readonly page: Page<false> }) => Promise<void>
type Pages<Names extends string> = { readonly [Name in Names]: Page<false> }

/** The forms of `test` these tests use with saved states and named apps. */
export type UnregisteredForms = {
  (name: string, options: { readonly state: string }, body: PageBody): void
  <const Names extends string>(name: string, options: { readonly apps: readonly Names[]; readonly state: { readonly [Name in Names]: string } }, body: (pages: Pages<Names>) => Promise<void>): void
  setup(state: string, body: PageBody): void
  setup<const Name extends string>(state: string, options: { readonly apps: readonly [Name] }, body: (pages: Pages<Name>) => Promise<void>): void
}

/** `test`, with the forms a registered config would give it. */
export const stateTest: typeof test & UnregisteredForms = test as typeof test & UnregisteredForms
