# TypeScript patterns and tooling for Retest

Research for the developer-experience plan, 30 September 2026. Track: TypeScript patterns and tooling. Goal from the founder: most mistakes in a Retest test should surface from `tsc --noEmit` before any test runs.

How to read the evidence marks:

- **[ran]** reproduced locally on 30 September 2026 with TypeScript 6.0.3 and Node.js 24.12.0, in a scratch directory outside this repository (deleted afterwards). Commands and outputs are quoted.
- **[source]** read in an official document, release note, package metadata or source file. The link sits next to the claim.
- **[unverified]** a claim from a secondary source or from memory that could not be confirmed. Treat as a lead only.

TypeScript 7 was not installed locally, so nothing here was run under TypeScript 7. Every TypeScript 7 statement is **[source]**.

## 0. Verdicts at a glance

| Topic | Verdict | Reason |
| --- | --- | --- |
| Register interface for the config | Adapt | Works [ran]. Libraries that use it fall back silently when it is missing; Retest should fail loudly with a branded error type instead (Drizzle precedent). |
| Apps declared per test, destructuring checked | Adopt | `const` type parameter plus a mapped type gives `Property 'phone' does not exist on type 'Handles<"web">'` [ran]. |
| Platform locator types, typed ARIA roles, typed test ids | Adopt | Each misuse is a plain TS2339 or TS2345 error [ran]. |
| `secret('name')` as an opaque object, not a branded string | Adopt | Blocks `const s: string = secret(...)` [ran]; cannot block template interpolation [ran], so runtime redaction and a lint rule remain necessary. |
| `toBe(expected: NoInfer<Actual>)` | Adopt | Vitest and Playwright both accept anything [source]; `NoInfer` rejects `expect(count).toBe('3')` [ran]. |
| One `expect` with non-distributive dispatch to value or locator matchers | Adopt | Playwright does the same split with conditional types [source]; the prototype rejects promises, secrets and `any` with readable messages [ran]. |
| `test.eval` cases typed by Standard Schema, interface copied in | Adopt | MIT, copying is explicitly allowed [source]; Zod 4.5.4 and Valibot 1.4.2 schemas type-check against a copied interface [ran]. Keep the MIT notice. |
| Compile-fail fixtures through the TypeScript JavaScript API | Avoid as the primary path | TypeScript 7.0 ships no stable API and its root export is only a version file [source]. |
| Compile-fail fixtures by parsing `tsc --noEmit --pretty false` | Adopt | Same seam Vitest uses [source]; works on 6.x now [ran] and the 7.x formatter prints the same shape [source]. |
| tsd, tstyche, expect-type | Avoid as dependencies, adapt ideas | tsd bundles its own compiler and last shipped August 2025; tstyche does not support TypeScript 7 yet [source]. |
| Generated types for test ids, routes, roles | Avoid for now | Test ids come from a TypeScript constant, so inference is enough. Generate only facts TypeScript cannot see, later. |
| Node type stripping for test files | Adopt | Stable in Node 24.12 [source], no warning printed [ran]. Every runtime failure has a matching compiler flag [ran]. |
| Static detection of un-awaited promises | Adapt | No test framework ships one. Recommend oxlint type-aware or typescript-eslint, and keep Retest's runtime detection mandatory. |

## 1. State of TypeScript, September 2026

### Releases

| Release | Date | Evidence |
| --- | --- | --- |
| 5.9.3 | 1 October 2025 | [GitHub releases](https://github.com/microsoft/TypeScript/releases) |
| 6.0.2 (6.0 GA) | 23 March 2026 | [Announcing TypeScript 6.0](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/); npm time 2026-03-23 |
| 6.0.3 | 16 April 2026 | npm registry time |
| 7.0 beta | 21 April 2026 | [Announcing TypeScript 7.0 Beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/) |
| 7.0.1-rc | 18 June 2026 | [Announcing TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/) |
| 7.0.2 (7.0 GA, npm `latest`) | 8 July 2026 | [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/); npm `latest` is `7.0.2`, `next` is `7.1.0-dev.20260929.1` ([registry](https://registry.npmjs.org/typescript)) |
| 7.1 beta, RC, stable (planned) | 6 October, 10 November, 24 November 2026 | [TypeScript 7.1 Iteration Plan #63703](https://github.com/microsoft/TypeScript/issues/63703) |

TypeScript 6.0 is "the last release based on the current JavaScript codebase" and no 6.1 is planned ([6.0 post](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/), [December 2025 progress post](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)). The Go code moved into `microsoft/TypeScript` under `tsc/`; `microsoft/typescript-go` was archived, last pushed 31 August 2026 [source: `gh api repos/microsoft/typescript-go` returned `archived: true`]. The Go module was renamed to `github.com/microsoft/TypeScript/tsc` on 20 August 2026 (commit history of `tsc/internal/checker/tracer.go`).

### TypeScript 7 and the compiler API

This matters because the founder's plan relies on the compiler API for compile-fail tests and a future `retest check`.

- "TypeScript 7.0 does not ship with an API. We expect TypeScript 7.1 to ship with a new (and different) API, but until then we have made it a priority to ensure TypeScript can be run side-by-side with TypeScript 6.0." ([7.0 post](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0), quoted in [typescript-eslint #10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940))
- The `typescript@7.0.2` package's `exports` map points `"."` at `./lib/version.cjs` only. Everything else is under `./unstable/*`: `unstable/sync`, `unstable/async`, `unstable/ast`, `unstable/proto`, `unstable/fs` [source: [npm metadata](https://registry.npmjs.org/typescript), same map in `7.1.0-dev.20260929.1`]. Consequence: `import ts from 'typescript'; ts.createProgram(...)` stops working the moment a user upgrades to 7.
- The unstable API is IPC-based. A `new API()` talks to a native process; programs come from snapshots, and diagnostics are plain objects with `code` and `text` (not TypeScript 6's `messageText` chain) [source: [`packages/typescript/src/api/async/api.ts`](https://github.com/microsoft/TypeScript/blob/main/packages/typescript/src/api/async/api.ts), [`proto.generated.ts` `DiagnosticResponse`](https://github.com/microsoft/TypeScript/blob/main/packages/typescript/src/api/proto.generated.ts)]:

```ts
// https://github.com/microsoft/TypeScript/blob/main/packages/typescript/test/diagnosticFormatter.test.ts
const snapshot = await api.createSnapshot({ openProject: "/project/tsconfig.json" });
const program = snapshot.getConfiguredProject("/project/tsconfig.json")!.program;
const diagnostics = await program.getSemanticDiagnostics("/project/index.ts");
const plain = formatDiagnostics(diagnostics, program);
assert.equal(plain, "index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\r\n");
```

- The 7.1 plan's API work is "Stabilize API: Content Mapper API, Emit API, Language Service API" ([#63703](https://github.com/microsoft/TypeScript/issues/63703)). A checker-level API for diagnostics is not named in that list [unverified whether diagnostics are part of the stable 7.1 surface].
- Side by side: `@typescript/typescript6` provides a `tsc6` binary and the old JavaScript API; the post shows `"typescript": "npm:@typescript/typescript6@^6.0.2"` beside `"@typescript/native": "npm:typescript@^7.0.2"` ([7.0 post](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)). The package is Apache-2.0, latest 6.0.2 [source: npm].
- Ecosystem reaction: typescript-eslint said on 9 July 2026 "For **now** - there is nothing we can do to support tsgo / TSv7 ... there is currently no stable JS API" and has an experimental native backend in draft ([#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940), [PR #12803](https://github.com/typescript-eslint/typescript-eslint/pull/12803)). Next.js now runs the project's `tsc` CLI by default because "TypeScript 7 does not currently provide the JavaScript compiler API" ([Next.js TypeScript docs](https://nextjs.org/docs/app/api-reference/config/typescript)). tstyche falls back to 6.0 when 7 is installed ([tstyche TypeScript versions](https://tstyche.org/guides/typescript-versions), [tstyche #443](https://github.com/tstyche/tstyche/issues/443)).

Verdict for Retest: **avoid** building on either JavaScript API today. **Adopt** the CLI's plain output as the stable seam (section 8). Revisit after 7.1 ships and has been stable for a release.

### TypeScript 6 and 7 defaults that change what users see

From the [6.0 post](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/) and carried into 7.0 ([7.0 post](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)) [source]:

- `strict: true`, `module: esnext`, `target: es2025`, `types: []`, `rootDir: .`, `noUncheckedSideEffectImports: true` are defaults. `types: []` means `@types/node` globals such as `console` and `process` are absent unless listed.
- Removed in 7.0: `target: es5`, `moduleResolution: node`/`node10`/`classic`, `baseUrl`, `outFile`, AMD/UMD/System, `esModuleInterop: false`.
- 7.0 always uses stable type ordering; 6.0 has `--stableTypeOrdering` to match it.

Two consequences found while testing:

1. **Union order in error messages differs between 6.0 defaults and 7.0.** [ran]

```text
$ tsc --ignoreConfig --pretty false --noEmit --strict flags/order.ts
error TS2345: Argument of type '"suport"' is not assignable to parameter of type '"billing" | "support" | "sales"'.
$ tsc ... --stableTypeOrdering flags/order.ts          # 7.0 behaviour
error TS2345: Argument of type '"suport"' is not assignable to parameter of type '"billing" | "sales" | "support"'.
```

Compile-fail fixtures must match on the error code and a short fragment, never on a whole message.

2. **TypeScript 6 refuses file arguments when a tsconfig exists.** [ran] `tsc file.ts` beside a `tsconfig.json` prints `error TS5112: tsconfig.json is present but will not be loaded if files are specified on commandline. Use '--ignoreConfig' to skip this error.` A future `retest check` should always pass `-p <tsconfig>`.

### Performance tooling under 7

`--extendedDiagnostics` and `--generateTrace` exist in the Go compiler. Tracing was added on 24 April 2026 and fixed "to make analyze-trace work" on 12 May 2026, before 7.0 GA [source: commits on [`tsc/internal/checker/tracer.go`](https://github.com/microsoft/TypeScript/commits/main/tsc/internal/checker/tracer.go); option declarations in `tsc/internal/tsoptions/declscompiler.go`]. `@typescript/analyze-trace` 0.11.1 shipped 26 June 2026 [source: npm]. Not run under 7 [unverified that 7's trace output is fully compatible].

## 2. Compiler flags

| Flag or feature | Since | What it catches | Users | Retest itself |
| --- | --- | --- | --- | --- |
| `erasableSyntaxOnly` | 5.8 ([notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html)) | enums, runtime namespaces, parameter properties, `import =`/`export =`. [ran] `enum` gives `TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled.` | Yes | Yes |
| `verbatimModuleSyntax` | 5.0 | A type imported without `type`, which Node then fails to find. [ran] `TS1484: 'Task' is a type and must be imported using a type-only import when 'verbatimModuleSyntax' is enabled.` | Yes | Yes |
| `rewriteRelativeImportExtensions` | 5.7 ([notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-7.html)) | Lets `./x.ts` imports type-check and rewrites them to `.js` on emit. Relative paths only; not `paths`, packages, `#imports` or computed imports. [ran] With it alone, `import './app/test-ids.ts'` type-checks; without it and without `allowImportingTsExtensions`: `TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.` | Yes | Yes (needed for emit) |
| `allowImportingTsExtensions` | 5.0 | Allows `.ts` specifiers only with `noEmit` or declaration-only emit. Redundant when the rewrite flag is on [ran]. | No | No |
| `module: nodenext` (or `node20`) | 4.7 / 5.9 [node20 version from memory] | [ran] extensionless relative import: `TS2835: Relative import paths need explicit file extensions ... Did you mean './types.js'?` `node20` is accepted by 6.0.3 [ran]. | Yes | Yes |
| `noUncheckedIndexedAccess` | 4.1 | `rows[0].text` where `rows[0]` may be missing. | Yes | Yes |
| `exactOptionalPropertyTypes` | 4.4 | [ran] passing `{ timeout: number \| undefined }` to `timeout?: number` gives `TS2379 ... Consider adding 'undefined' to the types of the target's properties.` | Optional | Yes, and Retest's public types must write `timeout?: number \| undefined` so they work with the flag on or off. The Standard Schema spec does the same. |
| `isolatedDeclarations` | 5.5 | Exports need explicit types so `.d.ts` can be emitted per file. [ran] `TS9016: Objects that contain shorthand properties can't be inferred with --isolatedDeclarations.` | No | Yes. It also keeps the public surface deliberate. |
| `NoInfer<T>` | 5.4 | Stops an argument from widening a type parameter. Basis of `toBe` below. | n/a | Yes |
| `const` type parameters | 5.0 | [ran] without `const`, `defineConfig({ testIds: { save: 'save-task' } })` widens to `string` and test-id checking silently disappears: `TS2322: Type 'string' is not assignable to type '"save-task"'` on the non-const variant. | n/a | Yes, on `defineConfig` and on `test`'s app list |
| `lib` without `dom` | n/a | Test bodies run in Node, so `document.querySelector` in a test body is a mistake. TypeScript's default `lib` includes DOM. With `lib: ["es2025"]` and no `@types/node`, even `console` is missing [ran: `TS2584: Cannot find name 'console'`], so users need `types: ["node"]`. | Yes | Yes |
| `lib: esnext` | n/a | Avoid. TypeScript 6 includes Temporal and `Map.getOrInsert` types [source: 6.0 post]; Node 24.12 has neither [ran: `typeof Temporal` is `undefined`]. Node 24.12 does have the ES2025 built-ins checked (`RegExp.escape`, `Promise.try`, `Float16Array`, iterator helpers, Set methods) [ran]. | Use `es2025` | Use `es2025` |

## 3. Node.js type stripping

From the [Node.js TypeScript documentation](https://nodejs.org/api/typescript.html) [source]:

| Version | Change |
| --- | --- |
| v22.18.0, v23.6.0 | Type stripping enabled by default |
| v24.12.0, v25.2.0 | Type stripping marked stable |
| v26.0.0 | `--experimental-transform-types` removed |

- Unsupported syntax raises `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: enums, namespaces with runtime code, parameter properties, import aliases, decorators. Type-only namespaces are fine.
- Imports need the real extension (`./file.ts`), types need `import type` or inline `type`, `.tsx` is unsupported, `tsconfig.json` is not read (no `paths`), no source maps are generated (types become whitespace, so line numbers hold), and files under `node_modules` are refused.
- Opt out with `--no-strip-types`.
- Node's recommended tsconfig: `noEmit`, `target: esnext`, `module: nodenext`, `rewriteRelativeImportExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`.

Reproduced on Node 24.12.0 [ran]:

```text
node enum.ts               SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode
node param-props.ts        SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
node no-type-keyword.ts    SyntaxError: The requested module './types.ts' does not provide an export named 'Task'
node no-extension.ts       ERR_MODULE_NOT_FOUND
node from-node-modules.ts  Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules
node ok.ts                 ok 1 Release checklist        (stderr empty: no experimental warning on 24.12)
```

Every one of these runtime failures has a compile-time twin under the recommended flags: TS1294, TS1484, TS2835 [ran]. That is the argument for making those flags part of Retest's documented setup: the type check finds them before a child process does.

Current release lines: Node 26.10.0 (current, 21 September 2026), 24.21.0 LTS "Krypton", 22.23.3 LTS [source: [nodejs.org/dist/index.json](https://nodejs.org/dist/index.json)].

Verdict: **adopt** for user test files, as the architecture already proposes. Retest's own package still ships compiled JavaScript and declarations because stripping is refused inside `node_modules`.

## 4. How Vitest and Playwright type fixtures and matchers

Versions checked: Vitest 5.0.2 (25 September 2026), `@playwright/test` 1.63.0 (4 September 2026) [source: npm].

### Fixtures

**Vitest builder (4.1+), inferred from return values.** [source: [Vitest test context](https://vitest.dev/guide/test-context)]

```ts
export const test = baseTest
  .extend('config', { port: 3000, host: 'localhost' })
  .extend('server', async ({ config }) => {
    return `http://${config.host}:${config.port}`
  })

const test = baseTest
  .extend('database', { scope: 'file' }, async ({}, { onCleanup }) => {
    const db = await createDatabase()
    await db.connect()
    onCleanup(async () => { await db.disconnect() })
    return db
  })
```

The docs call the builder "the recommended way to define fixtures because it provides automatic type inference" and say "With the builder pattern, TypeScript automatically enforces scope-based access rules". The older object form needs a manual generic because "TypeScript cannot infer them from the `use()` callback":

```ts
const test = baseTest.extend<{ page: Page; baseUrl: string }>({
  page: async ({}, use) => { const page = await browser.newPage(); await use(page); await page.close() },
  baseUrl: 'http://localhost:3000',
})
```

**Playwright: two generics, tuples for options.** [source: [`test.d.ts`](https://github.com/microsoft/playwright/blob/main/packages/playwright/types/test.d.ts), [Playwright fixtures](https://playwright.dev/docs/test-fixtures)]

```ts
extend<T extends {}, W extends {} = {}>(fixtures: Fixtures<T, W, TestArgs, WorkerArgs>): TestType<TestArgs & T, WorkerArgs & W>;

export const test = base.extend<{}, { account: Account }>({
  account: [async ({ browser }, use, workerInfo) => { /* ... */ await use({ username, password }) }, { scope: 'worker' }],
})

export const test = base.extend<Options & { todoPage: TodoPage }>({
  defaultItem: ['Do stuff', { option: true }],
  todoPage: async ({ page, defaultItem }, use) => { /* ... */ },
})

export default defineConfig<Options>({ projects: [{ name: 'shopping', use: { defaultItem: 'Buy milk' } }] })
```

Where they are loose:

- Playwright types fixtures by hand: the generic is a claim, not an inference. A wrong generic type-checks until the fixture body disagrees.
- Playwright config options are checked only if the author passes `defineConfig<Options>`; without it, a misspelt option in `use` is not tied to the test's options.
- Vitest's object form has the same manual-generic weakness; the builder removes it.

Verdict: **adapt** the Vitest builder when Retest adds user fixtures (the brief defers `test.extend`). Inference from return values and type-enforced scopes are the right defaults. **Avoid** Playwright's tuple-plus-generic form.

### Matchers

**Vitest `toBe` accepts anything.** [source: [`packages/expect/src/types.ts`](https://github.com/vitest-dev/vitest/blob/main/packages/expect/src/types.ts)]

```ts
export interface ExpectStatic extends Chai.ExpectStatic, Matchers<any>, AsymmetricMatchersContaining {
  <T>(actual: T, message?: string): Assertion<void, T>
  // ...
}
toEqual: <E>(expected: E) => R
toBe: <E>(expected: E) => R
toContain: <E>(item: E) => R
```

`T` is carried but not used to constrain `expected`. Vitest 5 made assertion interfaces `Assertion<R, T>` with the return type first ([Vitest 5 migration](https://vitest.dev/guide/migration/)).

**Playwright `toBe` accepts `unknown`, but splits matcher sets by receiver type.** [source: `test.d.ts`]

```ts
toBe(expected: unknown): R;

type SpecificMatchers<R, T> =
  T extends Page ? PageAssertions & AllowedGenericMatchers<R, T> :
  T extends Locator ? LocatorAssertions & AllowedGenericMatchers<R, T> :
  T extends APIResponse ? APIResponseAssertions & AllowedGenericMatchers<R, T> :
  BaseMatchers<R, T> & (T extends Function ? FunctionAssertions : {});
type IfAny<T, Y, N> = 0 extends (1 & T) ? Y : N;
// MakeMatchers: IfAny<T, AllMatchers<R, T>, SpecificMatchers<R, T> & ToUserMatcherObject<ExtendedMatchers, R, T>>
```

So `expect(locator).toHaveText(...)` is checked, but `AllowedGenericMatchers` still lets `toBe` onto a locator, and `any` unlocks every matcher.

**Custom matcher typing.**

- Vitest augments an interface. "Don't forget to include the ambient declaration file in your `tsconfig.json`" and "Importing `vitest` makes TypeScript think this is an ES module file, type declaration won't work without it." ([Extending matchers](https://vitest.dev/guide/extending-matchers)) Vitest 5 no longer reads global `jest.Matchers`.

```ts
import 'vitest'
declare module 'vitest' {
  interface Matchers<R, T> {
    toBeFoo: () => R
  }
}
```

- Playwright returns a new typed `expect` from `expect.extend`, so no augmentation is needed, and `ToUserMatcherObject` exposes a matcher only when its first parameter accepts the receiver type:

```ts
extend<MoreMatchers extends Record<string, (this: ExpectMatcherState, receiver: any, ...args: any[]) => MatcherReturnType | Promise<MatcherReturnType>>>(matchers: MoreMatchers): Expect<ExtendedMatchers & MoreMatchers>;
```

Verdict: **adopt** Playwright's value-returning `expect.extend` shape, with the receiver-type filter, when Retest adds custom matchers. It needs no augmentation file and cannot be broken by a tsconfig `include`. **Avoid** `receiver: any` in Retest's own signature (repo rule); use `receiver: never` in the constraint and infer the first parameter.

### Type tests in these frameworks

Vitest's type testing "calls `tsc` or `vue-tsc` ... and parses results" on `*.test-d.ts` files ([Testing types](https://vitest.dev/guide/testing-types)). `typecheck.checker` takes `'tsc' | 'vue-tsc' | string`, and a custom binary must produce "the same output format as `tsc --noEmit --pretty false`" ([typecheck config source](https://github.com/vitest-dev/vitest/blob/main/docs/config/typecheck.md)). That is the precedent for section 8. Vitest also warns that with `@ts-expect-error` "you might want to make sure that you didn't make a typo."

## 5. The Register pattern

### How others set it up

TanStack Router [source: [type safety guide](https://tanstack.com/router/latest/docs/framework/react/guide/type-safety), [`router-core/src/router.ts`](https://github.com/TanStack/router/blob/main/packages/router-core/src/router.ts)]:

```ts
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

// library side
export interface Register {}
export type RegisteredRouter<TRegister = Register> = TRegister extends { router: infer TRouter }
  ? TRouter
  : AnyRouter   // silent fallback: RouterCore<any, any, any, any, any>
```

TanStack Start's generated `routeTree.gen.ts` writes the registration itself ([example](https://github.com/TanStack/router/blob/main/examples/react/start-basic/src/routeTree.gen.ts)):

```ts
declare module '@tanstack/react-start' {
  interface Register {
    ssr: true
    router: Awaited<ReturnType<typeof getRouter>>
  }
}
```

wagmi registers a config, the closest match to Retest [source: [wagmi TypeScript](https://wagmi.sh/react/typescript)]. It also offers passing `config` explicitly for projects with several configs, and asks users to pin `typescript` because type changes ship in patches:

```ts
declare module 'wagmi' {
  interface Register {
    config: typeof config
  }
}
```

TanStack Query registers `defaultError`, `queryMeta` and `mutationMeta`; unregistered, errors default to `Error` ([TanStack Query TypeScript](https://tanstack.com/query/latest/docs/framework/react/typescript)).

### Failure modes, reproduced

All [ran] against a mock `@rehearsal-labs/retest` package in a scratch `node_modules`.

| Failure | What TypeScript does | What Retest should do |
| --- | --- | --- |
| No registration anywhere | TanStack and wagmi fall back to wide types silently. With Retest's prototype: `TS2349: This expression is not callable. Type 'RetestTypeError<"Register your config: declare module \"@rehearsal-labs/retest\" { interface Register { config: typeof config } }">' has no call signatures.` | Fail loudly, as prototyped. |
| Config file not in the program (tsconfig `include` misses it, or an editor opens a test under another tsconfig) | Same as no registration. A test that imports the config, even `import '../retest.config.ts'`, sees it (exit 0). | Loud error as above; `retest init` writes an `include` that covers the config; a future `retest check` reports which tsconfig lacks it. |
| Two registrations with different types | `TS2717: Subsequent property declarations must have the same type. Property 'config' must be of type '{ ... }', but here has type '{ ... }'.` Loud but long. | Accept; document one registration per program. Offer an explicit-config escape later (wagmi style) if monorepos need two. |
| `declare module` in a file with no `import`/`export` | The block becomes an ambient module that replaces the package: `TS2305: Module '"@rehearsal-labs/retest"' has no exported member 'test'.` | Keep the registration in `retest.config.ts`, which always imports `defineConfig`. Say so in the docs; this is the trap Vitest's docs warn about. |
| Two copies of the package installed | The augmentation reaches one copy while tests import the other [unverified, not reproduced]. With a loud default this reads as "not registered". | Loud default makes it visible; `retest check` can compare resolved package paths. |

The loud default borrows Drizzle's approach. When the schema generic is missing, `db.query` has type `DrizzleTypeError<'Seems like the schema generic is missing - did you forget to add it to your DB type?'>` [source: [`drizzle-orm/src/utils.ts`](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/utils.ts), installed `sqlite-core/db.d.ts` 0.45.2].

Verdict: **adapt**. Use `interface Register {}` and a `Register extends { config: infer C }` lookup, but make the unregistered branch a `RetestTypeError<'...'>` instead of a wide fallback.

Open decision for the founder: the first-milestone brief uses `test('saves a task', async ({ page }) => ...)` with no config. With a loud unregistered branch, that example fails `tsc` until the user adds a config. Either ship milestone 1 before Register and add Register with multi-app config, or make `retest init` write the config and registration from the start. A silent default app would repeat TanStack's failure mode.

## 6. Generated types versus inference

| Tool | What is generated | Why | Cost |
| --- | --- | --- | --- |
| Next.js typed routes | `.next/types` and `next-env.d.ts` during `next dev`, `next build` or `next typegen`; the tsconfig must include `.next/types/**/*.ts` | Routes are files; literal `href`s are checked, others need `as Route` ([Next.js TypeScript](https://nextjs.org/docs/app/api-reference/config/typescript)) | Stale until a command runs; the include line is easy to miss |
| React Router 7 | `.react-router/types/+types/<route>.d.ts` via `react-router typegen [--watch]`, needs `rootDirs` ([type safety](https://reactrouter.com/explanation/type-safety)) | "TypeScript cannot use the filesystem as part of its type inference nor type checking. The only tenable way to infer types based on file paths is through code generation." ([decision 0012](https://github.com/remix-run/react-router/blob/main/decisions/0012-type-inference.md)) | The decision names out-of-sync files as the known drawback; `--watch` is the mitigation |
| TanStack Router | `routeTree.gen.ts`, which also writes the `Register` block | File-based routes; code-based routes use pure inference | Generated file committed or regenerated |
| Nuxt | `.nuxt/` tsconfigs and declarations via `nuxt prepare` ([Nuxt TypeScript](https://nuxt.com/docs/4.x/guide/concepts/typescript)) | Auto-imports and aliases | Type check is off by default; needs `nuxt typecheck` |
| Astro | `.astro/types.d.ts`, included from tsconfig; `astro check` for checking ([Astro TypeScript](https://docs.astro.build/en/guides/typescript/)) | Content collections and virtual modules | Same staleness |

Pattern: frameworks generate types only for facts that live outside TypeScript (the file system, content files, virtual modules). Where the source of truth is already TypeScript, they infer.

Verdict for Retest: **avoid codegen now**. App names, platforms, secrets and test ids come from `retest.config.ts` and an app-exported constant, so inference covers them [ran]. Consider a `retest types` command later only for facts TypeScript cannot see, such as test ids scraped from markup or roles from a recorded accessibility snapshot. If it comes, it should write one `.d.ts` that augments `Register` (TanStack's approach) and `retest check` should flag it as stale.

## 7. Recommended type design, prototyped

The declarations below were written as a mock package in a scratch `node_modules` and type-checked with TypeScript 6.0.3 under a tsconfig close to section 12 [ran]. The `expect` part was checked in a separate file with the same code. They are a sketch of the public shape, not implementation. Phone role names are placeholders.

```ts
// @rehearsal-labs/retest (declarations)
declare const retestTypeError: unique symbol
export interface RetestTypeError<Message extends string> { readonly [retestTypeError]: Message }

export interface Register {}
type RegisteredConfig = Register extends { config: infer C extends RetestConfig } ? C : never
type IsRegistered = [RegisteredConfig] extends [never] ? false : true

export interface WebApp { readonly platform: 'web'; readonly baseUrl: string }
export interface PhoneApp { readonly platform: 'android' | 'ios'; readonly bundleId: string }
export interface RetestConfig {
  readonly apps: Readonly<Record<string, WebApp | PhoneApp>>
  readonly secrets?: readonly string[] | undefined
  readonly testIds?: Readonly<Record<string, string>> | undefined
}
export declare function defineConfig<const Config extends RetestConfig>(config: Config): Config

type TestId = RegisteredConfig extends { testIds: infer Ids } ? Ids[keyof Ids] & string : string
type SecretName = RegisteredConfig extends { secrets: readonly (infer Name extends string)[] } ? Name : string
declare const secretBrand: unique symbol
export interface Secret { readonly [secretBrand]: SecretName }
export declare function secret<const Name extends SecretName>(name: Name): Secret

export interface WebLocator { click(): Promise<void>; fill(value: string | Secret): Promise<void> }
export interface PhoneLocator { tap(): Promise<void>; typeText(value: string | Secret): Promise<void> }
export interface WebAppHandle {
  goto(path: `/${string}`): Promise<void>
  getByRole(role: WebRole, options?: { name?: string | RegExp | undefined }): WebLocator
  getByTestId(id: TestId): WebLocator
}
export interface PhoneAppHandle {
  getByRole(role: PhoneRole, options?: { name?: string | RegExp | undefined }): PhoneLocator
  getByTestId(id: TestId): PhoneLocator
}
type HandleFor<App> = App extends WebApp ? WebAppHandle : App extends PhoneApp ? PhoneAppHandle : never
type AppName = keyof RegisteredConfig['apps'] & string
type Handles<Names extends AppName> = { readonly [Name in Names]: HandleFor<RegisteredConfig['apps'][Name]> }

type TestFunction = IsRegistered extends true
  ? <const Names extends AppName>(
      name: string,
      options: { readonly apps: readonly Names[]; readonly timeout?: number | undefined },
      body: (apps: Handles<Names>) => Promise<void>,
    ) => void
  : RetestTypeError<'Register your config: declare module "@rehearsal-labs/retest" { interface Register { config: typeof config } }'>
export declare const test: TestFunction

export interface LocatorAssertions {
  toBeVisible(options?: { timeout?: number | undefined }): Promise<void>
  toHaveText(expected: string | RegExp, options?: { timeout?: number | undefined }): Promise<void>
}
export interface ValueAssertions<Actual> {
  toBe(expected: NoInfer<Actual>): void
  toEqual(expected: NoInfer<Actual>): void
}
type IsAny<T> = 0 extends 1 & T ? true : false
export type Assertions<Actual> =
  IsAny<Actual> extends true ? RetestTypeError<'expect() received an any value; give it a type first'>
  : [Actual] extends [WebLocator | PhoneLocator] ? LocatorAssertions
  : [Actual] extends [PromiseLike<unknown>] ? RetestTypeError<'Await the promise before expect()'>
  : [Actual] extends [Secret] ? RetestTypeError<'A secret cannot be compared or printed'>
  : ValueAssertions<Actual>
export declare function expect<Actual>(actual: Actual): Assertions<Actual>
```

User side:

```ts
// retest.config.ts
import { defineConfig } from '@rehearsal-labs/retest'
import { testIds } from './app/test-ids.ts'   // export const testIds = { saveTask: 'save-task', ... } as const

export const config = defineConfig({
  apps: {
    web: { platform: 'web', baseUrl: 'http://127.0.0.1:3000' },
    phone: { platform: 'ios', bundleId: 'dev.rehearsal.tasks' },
  },
  secrets: ['password'],
  testIds,
})

declare module '@rehearsal-labs/retest' {
  interface Register { config: typeof config }
}

// tests/task.test.ts (type-checks cleanly [ran])
test('saves a task', { apps: ['web', 'phone'] }, async ({ web, phone }) => {
  await web.goto('/')
  await web.getByTestId('task-title').fill('Release checklist')
  await web.getByRole('textbox', { name: 'Password' }).fill(secret('password'))
  await web.getByTestId('save-task').click()
  await expect(web.getByTestId('saved-task')).toHaveText('Release checklist')
  await phone.getByRole('button', { name: 'Sync' }).tap()
})
```

Each mistake below was one fixture file, checked with `tsc --pretty false` [ran]:

| Mistake | Diagnostic |
| --- | --- |
| Destructure an undeclared app | `TS2339: Property 'phone' does not exist on type 'Handles<"web">'.` |
| Declare an app not in the config | `TS2322: Type '"desktop"' is not assignable to type 'AppName'.` |
| Phone action on a web locator | `TS2339: Property 'tap' does not exist on type 'WebLocator'.` |
| Role typo | `TS2345: Argument of type '"buton"' is not assignable to parameter of type 'WebRole'.` |
| Test id typo | `TS2345: Argument of type '"save-tsk"' is not assignable to parameter of type '"save-task" \| "task-title" \| "saved-task"'.` |
| Secret name typo | `TS2345: Argument of type '"pasword"' is not assignable to parameter of type '"password"'.` |
| Secret used as a string | `TS2322: Type 'Secret' is not assignable to type 'string'.` |
| `goto('tasks')` | ``TS2345: Argument of type '"tasks"' is not assignable to parameter of type '`/${string}`'.`` |
| `expect(count).toBe('3')` | `TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.` |
| Value matcher on a locator | `TS2339: Property 'toBe' does not exist on type 'LocatorAssertions'.` |
| Locator matcher on a value | `TS2339: Property 'toHaveText' does not exist on type 'ValueAssertions<"Release checklist">'.` |
| `expect(promise)` | `TS2339: Property 'toBe' does not exist on type 'RetestTypeError<"Await the promise before expect()">'.` |
| `expect(secret)` | `TS2339: Property 'toBe' does not exist on type 'RetestTypeError<"A secret cannot be compared or printed">'.` |
| `expect(anyValue)` | `TS2339: Property 'toBe' does not exist on type 'RetestTypeError<"expect() received an any value; give it a type first">'.` |
| Literal typo against a union | `TS2345: Argument of type '"eror"' is not assignable to parameter of type '"error" \| "ok"'.` |
| Extra key in `toEqual` | `TS2353: Object literal may only specify known properties, and 'b' does not exist in type '{ a: number; }'.` |

Still allowed, by design: `expect(caughtError /* unknown */).toBe('boom')`, `expect(maybeLocator /* Locator | undefined */).toBe(undefined)`, `expect([1, 2]).toEqual([1, 2])`.

Design notes from the experiments:

- **Use one `expect` signature with a tuple-wrapped conditional, not overloads.** A first version with overloads (`expect(locator)` then `expect<T>(value)`) produced a two-overload TS2769 wall for `expect(promise)`, and `any` matched the locator overload. The tuple wrap `[Actual] extends [...]` stops distribution over unions. The `IsAny` check is the same trick Playwright uses [source above].
- **Rejecting `any` is a product choice.** It follows the founder's goal. The message tells the author what to do; `as unknown` or a type annotation clears it. Playwright chose the opposite and unlocks all matchers.
- **Do not put `const` on `expect`.** It would infer `[1, 2]` as a readonly tuple and make `toEqual([1, 2, 3])` style edits awkward. `const` belongs on `defineConfig` and on `test`'s app names.
- **Asymmetric matchers later** (`expect.any(String)`) must be part of the parameter type, e.g. `toEqual(expected: DeepMatch<NoInfer<Actual>>)`. Vitest's `DeeplyAllowMatchers<T>` is a reference [source: Vitest `types.ts`].
- **Roles per platform.** Web roles come from ARIA. Native accessibility vocabularies differ, so `WebRole` and `PhoneRole` should be separate unions. Playwright writes the whole ARIA union inline in `getByRole(role: "alert"|"alertdialog"|...)` [source: [`playwright-core/types/types.d.ts`](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/types/types.d.ts)], which makes errors print the full list; a named alias prints the name.
- **"Did you mean" appears only outside argument position.** TypeScript suggested the nearest literal for an object property or a variable, but not for a direct argument [ran]:

```text
getByRole('buton')            TS2345: Argument of type '"buton"' is not assignable to parameter of type 'AriaRole'.
getBy({ role: 'buton' })      TS2820: Type '"buton"' is not assignable to type 'AriaRole'. Did you mean '"button"'?
const role: AriaRole = 'buton' TS2820: ... Did you mean '"button"'?
```

  Not a reason to change the API, but worth knowing when choosing between positional and option-object parameters.
- **Secrets.** TypeScript accepts `` `https://x.test/?p=${password}` `` and `'p=' + password` for an object-typed `Secret` with no error [ran]. Types stop `Secret` reaching a `string` parameter; they cannot stop string conversion. The runtime object needs `toString`, `toJSON` and `util.inspect.custom` that return a placeholder, and the recommended lint config should enable typescript-eslint `restrict-template-expressions` and `no-base-to-string`. A branded string (`string & { brand }`) would be worse: it is assignable to every `string` parameter.
- **`goto` path template.** `` `/${string}` `` rejects `'tasks'` and full URLs. Whether full URLs should be allowed is an API decision.

## 8. Compile-fail testing

### Existing tools

| Tool | How it checks failures | State | Verdict |
| --- | --- | --- | --- |
| `@ts-expect-error` | Suppresses the next line if any error occurs; cannot name a code. Proposals to add codes are open: [#45937](https://github.com/microsoft/TypeScript/issues/45937) "In Discussion", [#19139](https://github.com/microsoft/TypeScript/issues/19139) "Revisit" with 793 reactions [source: GitHub API] | Banned in Retest by repo rule | Avoid |
| tsd 0.33.0 | `expectError(expr)` passes only for a fixed list of codes (TS2345, TS2339, TS2322, TS2769 and about forty more) and never for syntax errors [source: [`source/lib/compiler.ts`](https://github.com/tsdjs/tsd/blob/main/source/lib/compiler.ts)]. Bundles its own `@tsd/typescript`. Last release 5 August 2025 [source: npm] | Stale against 6 and 7 | Avoid; borrow the idea of an allowed-code list |
| tstyche 7.2.5 | `expect(fn).type.not.toBeCallableWith(...)`; `.toRaiseError()` "is deprecated and planned to be removed" in favour of ability matchers that "work without introducing type errors in the test code" ([Expect API](https://tstyche.org/reference/expect-api)). Tests several TypeScript versions with `--target '>=5.6'`. "TypeScript 7 is not yet supported" ([versions](https://tstyche.org/guides/typescript-versions)) | Active, 6.0 ceiling | Avoid as a dependency now; revisit when #443 lands |
| expect-type 1.4.0 / Vitest `expectTypeOf` | Positive assertions (`toEqualTypeOf`, `toExtend`, `.branded`); negatives rely on `@ts-expect-error` ([expect-type](https://github.com/mmkal/expect-type)) | Active, Apache-2.0, zero dependencies | Adapt: a ten-line internal `Equal<A, B>` helper covers Retest's positive type tests |

Ability matchers such as `toBeCallableWith` suit single functions. Retest's important failures happen inside a callback (destructuring `{ web, phone }`, calling `.tap()` on a web locator), which ability matchers cannot express without rebuilding the callback's context. Real fixture files that look like user tests are the faithful check.

### Approach A: JavaScript compiler API (TypeScript 6 only) [ran]

```js
import ts from 'typescript' // 6.x, or @typescript/typescript6 beside 7
const program = ts.createProgram({ rootNames: [...roots, fixture], options })
const source = program.getSourceFile(fixture)
for (const diagnostic of ts.getPreEmitDiagnostics(program, source)) {
  const { line } = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  // claim it against a `// type-error TS2339 <fragment>` marker on the same line
}
```

Output on a fixture with one stale marker: `missing harness/fixture.ts:6 TS2345` and exit 1.

This breaks under TypeScript 7 (no `createProgram`, different diagnostic shape) [source, section 1].

### Approach B: parse the CLI (recommended) [ran]

```js
const run = spawnSync(tscBinary, ['-p', project, '--pretty', 'false', '--noEmit'], { encoding: 'utf8' })
for (const line of run.stdout.split('\n')) {
  const head = /^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line)
  if (head) diagnostics.push({ file: resolve(head[1]), line: Number(head[2]), code: Number(head[4]), message: head[5] })
  else if (line.startsWith('  ') && diagnostics.length > 0) diagnostics.at(-1).message += '\n' + line.trim()
}
```

Same fixture, same result: `missing harness/fixture.ts:6 TS2345`, exit 1. The fixture looks like this:

```ts
test('uses an undeclared app', { apps: ['web'] }, async ({ web, phone }) => { // type-error TS2339 Property 'phone' does not exist
  await web.getByRole('button').tap() // type-error TS2339 Property 'tap' does not exist on type 'WebLocator'
  expect(3 as number).toBe('3') // type-error TS2345
})
```

Rules the harness should enforce:

1. Every diagnostic in a fail fixture is claimed by a marker on its line: same code, message contains the fragment.
2. Every marker is used. A stale marker fails, which is exactly the `@ts-expect-error` typo problem Vitest warns about.
3. Pass fixtures have zero diagnostics.
4. Fragments avoid union order (section 1).
5. Run the fixture suite against each supported TypeScript line: minimum supported, 6.0 and 7.x. Declare them as aliased dev dependencies when the dependency decision is made.

Why B: it needs only the `tsc` binary; the plain format is what Vitest's `typecheck.checker` contract relies on; TypeScript 7's own formatter prints `index.ts(1,7): error TS2322: ...` [source, section 1]. The same parser can later power `retest check`, mapping diagnostics to collected tests by file and line as Vitest does. Its cost is one process per run and no access to types, which Retest's checks do not need.

Not verified: running approach B under TypeScript 7.0.2's CLI. The format claim rests on the 7.x API formatter test, not on a CLI run.

## 9. Readable type errors and type-check cost

Techniques that held up in the prototype [ran]:

- **A branded error interface.** `interface RetestTypeError<Message extends string> { readonly [retestTypeError]: Message }` keyed by a `unique symbol` so nothing satisfies it by accident. Returning it as a type puts the sentence into TS2339 or TS2349 messages (section 7). Drizzle's `DrizzleTypeError<T>` uses the same shape [source]. A first-class `invalid`/throw type is still only a proposal ([#23689](https://github.com/microsoft/TypeScript/issues/23689), "In Discussion").
- **Short, honest alias names.** Messages print alias names: `Handles<"web">`, `LocatorAssertions`, `AppName`. Name public types for what the author reads. `DeclaredApps<"web">` may read better than `Handles<"web">`.
- **Shallow conditionals.** Dispatch once (`Assertions<Actual>`), then use plain interfaces. The TypeScript wiki recommends interfaces over intersections, named conditional types instead of inline ones, explicit return types, and small unions ([Performance wiki](https://github.com/microsoft/TypeScript/wiki/Performance)).
- **Keep literals.** `const` type parameters on `defineConfig` and `test` (section 2).
- **Messages the copy rules would accept.** One sentence, plain verb, no internals: "Await the promise before expect()".

Measuring cost:

```sh
tsc -p tsconfig.json --noEmit --extendedDiagnostics   # Types, Instantiations, Check time, Memory used
tsc -p tsconfig.json --noEmit --generateTrace trace/   # then: npx @typescript/analyze-trace trace/
```

Probe [ran]: 300 generated tests against the prototype declarations.

| Program | Lines of TypeScript | Types | Instantiations | Check time |
| --- | --- | --- | --- | --- |
| Config only | 18 | 28,567 | 27,255 | 0.25 s |
| Config plus 300 tests | 2,720 | 33,634 | 27,932 | 0.30 s |

Most of the baseline is the standard library. The prototype adds about 17 types and 2 instantiations per test. The real declarations will be larger; add a budget check to Retest's CI that fails when instantiations per generated test cross a threshold set from the first real measurement.

## 10. Standard Schema

Interface [source: [spec source](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/src/index.ts), `@standard-schema/spec` 1.1.0, 15 December 2025, MIT]:

```ts
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}
export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    readonly validate: (value: unknown, options?: StandardSchemaV1.Options | undefined)
      => Result<Output> | Promise<Result<Output>>;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> { readonly value: Output; readonly issues?: undefined; }
  export interface FailureResult { readonly issues: ReadonlyArray<Issue>; }
  export interface Issue { readonly message: string; readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined; }
  export interface PathSegment { readonly key: PropertyKey; }
  export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}
// StandardTypedV1.Props: { readonly version: 1; readonly vendor: string; readonly types?: Types<Input, Output> | undefined }
```

Version 1.1 split out `StandardTypedV1` and added `StandardJSONSchemaV1`, with a `jsonSchema.input/output({ target: 'draft-2020-12' | 'draft-07' | 'openapi-3.0' })` converter [source: same file].

Implementers listed on [standardschema.dev/schema](https://standardschema.dev/schema): Zod 3.24.0+, Valibot 1.0+, ArkType 2.0+, Effect Schema 3.13.0+ (via adapter), yup 1.7.0+, joi 18.0.0+, and more [source]. Current: zod 4.6.5, valibot 1.5.0, arktype 2.2.5 [source: npm].

Without a dependency: the spec README says libraries "can copy/paste the code block below into their codebase" ([spec README](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/README.md)). The site FAQ says the package "is completely optional. You can just copy and paste the types into your project", and warns against installing it as a dev dependency because the interface becomes part of your public API ([standardschema.dev/schema](https://standardschema.dev/schema)). The repository is MIT, "Copyright (c) 2024 Colin McDonnell" ([LICENSE](https://github.com/standard-schema/standard-schema/blob/main/LICENSE)). MIT requires the notice in copies of substantial portions, so Retest (Apache-2.0) should keep the notice beside the copied file and list it in a third-party notices file. Types are erased from JavaScript output but ship in `.d.ts`, so the notice still applies.

Prototype [ran], with the interface copied (trimmed) and real Zod 4.5.4 and Valibot 1.4.2 from the local store:

```ts
export declare function evaluate<CaseSchema extends StandardSchemaV1>(
  name: string,
  options: { readonly case: CaseSchema; readonly cases: readonly StandardSchemaV1.InferInput<CaseSchema>[] },
  body: (evalCase: StandardSchemaV1.InferOutput<CaseSchema>) => Promise<void>,
): void

evaluate('routes tickets', {
  case: z.object({ message: z.string(), team: z.enum(['billing', 'support']), priority: z.coerce.number().default(1) }),
  cases: [{ message: 'Refund please', team: 'billing' }, { message: 'Password reset', team: 'suport' }],
}, async (evalCase) => { const priority: number = evalCase.priority })
```

```text
TS2820: Type '"suport"' is not assignable to type '"billing" | "support"'. Did you mean '"support"'?
TS2353: Object literal may only specify known properties, and 'extra' does not exist in type '{ message: string; team: "billing" | "support"; }'.   (Valibot case)
```

Cases are typed by the schema's input (`priority` optional), the body by its output (`priority: number`). Both libraries' schemas were structurally assignable to the copied interface with `exactOptionalPropertyTypes` on.

Runtime note: `validate` may return a promise. Retest should await it and report issues with their paths; the site's example throws on async schemas, which Retest does not need to do.

Verdict: **adopt**, copying the interface with its notice. No runtime dependency.

## 11. Un-awaited promises

TypeScript itself has no floating-promise check. Nothing in the type system can see a discarded expression result.

| Tool | Kind | State in September 2026 | Evidence |
| --- | --- | --- | --- |
| typescript-eslint `no-floating-promises` | Type-aware | 8.71.0 (28 September 2026). Options: `ignoreVoid` (default true), `ignoreIIFE`, `checkThenables`, `allowForKnownSafePromises`, `allowForKnownSafeCalls`. Runs on the TypeScript 6 API only; native backend is a draft | [rule docs](https://typescript-eslint.io/rules/no-floating-promises/), [#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) |
| oxlint `typescript/no-floating-promises` via tsgolint | Type-aware, built on TypeScript 7 | "Type-Aware Linting Stable", 22 July 2026; 59 of 61 typescript-eslint type-aware rules; requires TypeScript 7-compatible tsconfig; `oxlint-tsgolint` 7.0.2003 | [oxc blog](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable), [type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html) |
| Biome `noFloatingPromises` | Biome's own inference | Nursery, moved to a "types" domain in 2.4 [unverified: secondary sources only]; Biome 2.5.14 current | [rule page](https://biomejs.dev/linter/rules/no-floating-promises/) |
| eslint-plugin-playwright `missing-playwright-await` | Syntactic, no types | 2.12.0; knows Playwright's async matchers, `expect.poll`, `test.step`, `waitFor*`; `customMatchers` option | [rule docs](https://github.com/mskelton/eslint-plugin-playwright/blob/main/docs/rules/missing-playwright-await.md) |
| Deno lint | None | Cannot run type-aware rules; [deno_lint #303](https://github.com/denoland/deno_lint/issues/303) | [source] |
| Playwright Test runtime | None | Warning request closed "not planned": "Our recommendation at the moment is to use ESLint's `no-floating-promises` rule" and "We have explored it and decided it wasn't worth it." | [#37595](https://github.com/microsoft/playwright/issues/37595) |
| Vitest 5 runtime | Runtime failure | "Asynchronous assertions, like `resolves`, `rejects` and `toMatchFileSnapshot`, now fail the test if they are not awaited." Previously a warning and auto-await | [Vitest 5 migration](https://vitest.dev/guide/migration/) |

No test framework found ships its own static un-awaited check. The closest are a framework-specific syntactic lint plugin (Playwright's, community-maintained) and Vitest's runtime failure.

Verdict for Retest: **adapt**.

1. Keep the runtime rule already in the brief: work still pending when the callback ends fails the test, and a pending assertion's rejection is never lost. Make it name the source line of the un-awaited call, as Vitest 5 does.
2. Document a lint setup: oxlint with `--type-aware` and `typescript/no-floating-promises` for TypeScript 7 projects; typescript-eslint for 6.x projects. Retest's actions return native `Promise`s, so `checkThenables` is not needed.
3. Defer a built-in static check. A `retest check` rule would need a parser (TypeScript's), which conflicts with zero runtime dependencies unless it uses the user's installed TypeScript. If added, keep it syntactic and narrow: an expression statement whose call chain starts at `expect(` or at a declared app handle, without `await`, `return` or `void`.

## 12. Recommended tsconfig

### For users' test projects

```jsonc
{
  "compilerOptions": {
    "target": "es2025",                         // Node 24.12 has the ES2025 built-ins [ran]; 5.x lacks es2025: use es2024 there
    "lib": ["es2025"],                          // no "dom": test bodies run in Node, not the page
    "types": ["node"],                          // TypeScript 6+ defaults to []; needed for console and process
    "module": "nodenext",
    "strict": true,
    "noEmit": true,
    "erasableSyntaxOnly": true,                 // enums and parameter properties fail here, not in Node
    "verbatimModuleSyntax": true,               // missing `type` fails here, not in Node
    "rewriteRelativeImportExtensions": true,    // allows './file.ts' imports as Node requires
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,         // optional; Retest's types work either way
    "skipLibCheck": true
  },
  "include": ["retest.config.ts", "tests/**/*.ts", "app/test-ids.ts"]
}
```

The `include` must reach `retest.config.ts` or the registration is missing (section 5).

### For Retest itself

```jsonc
{
  "compilerOptions": {
    "target": "es2024",                         // emit target; raise after confirming the supported Node floor
    "lib": ["es2024"],
    "types": ["node"],
    "module": "nodenext",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "isolatedDeclarations": true,
    "strict": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "rewriteRelativeImportExtensions": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": false                       // check Retest's own public .d.ts
  },
  "include": ["src"]
}
```

Plus a `tests/types/tsconfig.json` that extends the user config above, run twice: once with `exactOptionalPropertyTypes` on and once off, so the public types work for both kinds of users.

Toolchain: `typescript` 7.x as the only compiler dev dependency; compile-fail fixtures through approach B; `@typescript/typescript6` only if a TypeScript 6 check is needed before 7.1's API settles. These are dependency decisions for the founder (AGENTS.md).

## 13. Risks

1. **TypeScript 7 API churn.** 7.0 has no stable API, the shipped one lives under `unstable/`, and 7.1's plan names a content-mapper, emit and language-service API but not explicitly diagnostics. Anything built on `import ts from 'typescript'` breaks on upgrade. Mitigation: CLI parsing now; an adapter interface so an API-backed checker can replace it later.
2. **Message drift across compiler versions.** Union ordering already differs between 6.0 defaults and 7.0 [ran]. Code-plus-fragment matching and a multi-version fixture run contain it.
3. **Registration visibility.** Editors and CI can use different tsconfigs; a script-file `declare module` erases the package [ran]; two package copies may split types [unverified]. The loud error makes each visible but does not fix it.
4. **Type-level cost as the API grows.** Mapped app handles, per-platform roles and registered test ids are cheap today [ran], but the full API and user fixtures will add more. Keep a measured budget.
5. **`any` rejection may annoy.** Deliberate, but it is the first place users will ask for an escape.
6. **Secrets and strings.** Types cannot prevent interpolation [ran]; the runtime placeholder and lint rules carry that part.
7. **Linting fragmentation.** typescript-eslint is blocked on 7 until its native backend lands; oxlint requires 7-compatible configs. Recommend both paths and do not make either a requirement.
8. **Node's stripping rules can move.** Stable since 24.12, but `--experimental-transform-types` was removed in 26 [source]. Retest should never rely on transform mode.
9. **MIT notice for the copied Standard Schema interface.** Easy to forget in an Apache-2.0 package.

## 14. What could not be verified

1. **Nothing ran under TypeScript 7.** The CLI output format, `--extendedDiagnostics`, `--generateTrace` with `@typescript/analyze-trace`, and every prototype error were checked on 6.0.3 only. The 7.x format claim rests on the 7.x API formatter test and source, not a CLI run.
2. **Whether TypeScript 7.1's stable API will expose program diagnostics.** The iteration plan does not say.
3. **Two installed copies of the package splitting the Register augmentation.** Reasoned, not reproduced.
4. **Minimum TypeScript version for users.** The prototype needs `NoInfer` (5.4), `const` type parameters (5.0) and the `infer X extends Y` form (4.7); `erasableSyntaxOnly` needs 5.8. Not run on 5.x.
5. **Biome `noFloatingPromises` stability and accuracy.** Only secondary sources and the rule page title were read.
6. **TypeScript 7.0.2's GitHub release date.** npm shows 7.0.2 on 8 July 2026 while the GitHub release object is dated 20 August 2026; the npm date and blog agree, so the table uses them.
7. **Several secondary articles** (InfoQ, Visual Studio Magazine, byteiota, dev.to) gave dates or claims that conflicted with primary sources, for example an August 2026 GA date. Only primary sources are used above.
