# ESM TypeScript loading: evaluation and choice

3 October 2026, revised the same day after review. Release 0.1.0, Phase 1 item 5 ([release-0.1.0.md](../release-0.1.0.md)), the TypeScript row of its scope table, "TypeScript and installation scope" in [releases.md](../releases.md) and section 7 of [plan.md](../plan.md). Before this change Retest loaded test files and the config with Node's type stripping alone: erasable syntax, explicit `.ts` extensions, no path aliases ([inventory.md](../inventory.md), "TypeScript").

## Result

Test files and `retest.config.ts` load through a load hook and a resolve hook of the project's, in Retest's process and in every test file's; a test file's process also registers, before any test file loads, a resolve hook that points Retest's own specifiers at the copy that runs it (`src/runner/own-package.ts`). The load hook calls `module.stripTypeScriptTypes`, the TypeScript transformer Node bundles (amaro 1.1.5 in Node 24.12.0): it strips types first, which keeps every line and column, and transforms with a source map only a file that stripping refuses, one with an enum, a namespace with values or a parameter property. The resolve hook reads the `paths` of the `tsconfig.json` nearest each importing file and resolves imports as `tsc` reads them: without an extension, by the `.js` of a `.ts` source, or as a folder. CommonJS test files, configs and TypeScript, JSX, decorators and a type imported without `type` fail as the file loads, naming the construct and the file. Retest has no runtime dependency, and TypeScript is needed only to check types; `init` writes the `tests/tsconfig.json` that checks them.

The transformer is a Node feature Node calls experimental: its first use prints "stripTypeScriptTypes is an experimental feature and might change at any time", and the documentation lists it as Stability 1.2, release candidate. The `engines` field asks for Node 24.12 or later, and that claim rests on Node 24.12.0 alone, the only Node 24 on this machine.

Three consumer projects in `fixtures/consumers/`, and a TypeScript 7 variant of one, prove it outside this checkout, through the packed package, in real Chrome. A test file's process with a warm compile cache now takes about 26 ms longer than plain type stripping would, because Node loads its transformer in every such process; cold, the difference is within a millisecond. Every probed source location came out exact: 24 of 24 sites in a transformed file.

## The two routes

Both were tried on this machine: Node 24.12.0, macOS 27.0, Apple M4 Max. TypeScript 6.0.3 and 7.0.2 are this repository's dev dependencies; they stand in for "the TypeScript the project installed". The timings are in [Measurements](#measurements); the capability rows come from hand-written TypeScript files run with each route.

| | Node's transformer (`--experimental-transform-types`, `module.stripTypeScriptTypes`) | TypeScript's `transpileModule`, from the project |
| --- | --- | --- |
| Available | In every Node 24.12 or later. Node prints that it is experimental and might change at any time; its documentation lists both entry points as Stability 1.2, release candidate | Only when the project installs `typescript` 6 or older. TypeScript 7's main export holds only `version` and `versionMajorMinor`, and its `unstable/` API, which talks to the native compiler, has no single-file transpile call |
| Enums, namespaces with values, parameter properties | Yes | Yes |
| Classes without decorators | Yes | Yes |
| `import type` | Yes. Every other import is kept as written, so a type imported without `type` fails at link time | Yes, and an import used only as a type is dropped, so a missing `type` still loads |
| Decorators | No. Left in the output, and Node 24 cannot parse them: "SyntaxError: Invalid or unexpected token" with no location | Yes, with `experimentalDecorators` |
| JSX | No. "Expression expected" | Yes, given `jsx`, and then the output imports `react/jsx-runtime` |
| Extensionless relative imports | No: a resolve hook's job in either route | No: same |
| `tsconfig` `paths`, `baseUrl`, `extends` | No: Node reads no tsconfig | No: `transpileModule` rewrites no specifier; `extends` needs `ts.readConfigFile` and `parseJsonConfigFileContent` |
| Source locations | Strip mode keeps every position. Transform mode writes an inline map; the flag implies `--enable-source-maps`. `util.getCallSites`, which Retest uses for every action and assertion location, maps only under `--enable-source-maps`, not after `module.setSourceMapsSupport(true)` | Yes, with `inlineSourceMap`, under `--enable-source-maps` |
| Result cached between runs | Under the flag, yes: Node keeps the transformed output in its compile cache and never loads the transformer on a warm start. Through `module.stripTypeScriptTypes`, no: the transformer loads in every process | No |

Both need a resolve hook for extensionless imports and aliases, and a tsconfig reader for `paths`, so neither saves that work.

## Measurements

`scripts/measure-loader.ts`, five runs each, median, minimum and maximum in milliseconds. Cold runs each get an empty `NODE_COMPILE_CACHE`; warm runs share one that an unmeasured run filled. The "node" rows start a bare Node on a three-file graph (a test-like file, an enum helper, a plain helper), every one with `--enable-source-maps --disable-warning=ExperimentalWarning`, so only the loading route differs. The "retest list" rows start the real command line on a one-test file in a temporary project, which collects it in a test file process as a run does, without a browser. "head" is a build of commit `dc95bb6`, before this lane; "current" is a build of this checkout, which also holds other lanes' uncommitted work; "head-source" and "source" run each from TypeScript with `--conditions=retest-source`, as the repository's tests do.

```sh
node scripts/measure-loader.ts head=/tmp/retest-loader-head/dist/cli/main.js current=/tmp/retest-loader-current2/dist/cli/main.js head-source=/tmp/retest-loader-head/src/cli/main.ts source=src/cli/main.ts
```

Run at 12:14 on 3 October 2026 under the heavy-gate lock, so no gate ran beside it, with a load average between 9 and 11 from other sessions:

| Route | Compile cache | Median ms | Min ms | Max ms |
| --- | --- | --- | --- | --- |
| node, type stripping, erasable file | cold | 47 | 46 | 48 |
| node, type stripping, erasable file | warm | 20 | 20 | 20 |
| node --experimental-transform-types, enum file | cold | 55 | 54 | 57 |
| node --experimental-transform-types, enum file | warm | 20 | 20 | 21 |
| node, stripTypeScriptTypes hook, erasable file | cold | 46 | 46 | 48 |
| node, stripTypeScriptTypes hook, erasable file | warm | 46 | 46 | 46 |
| node, stripTypeScriptTypes hook, enum file | cold | 56 | 55 | 57 |
| node, stripTypeScriptTypes hook, enum file | warm | 54 | 53 | 54 |
| node, typescript 6 transpileModule hook, enum file | cold | 145 | 142 | 145 |
| node, typescript 6 transpileModule hook, enum file | warm | 84 | 84 | 85 |
| retest list (head), erasable file | cold | 152 | 151 | 185 |
| retest list (head), erasable file | warm | 91 | 89 | 100 |
| retest list (head), enum, alias and extensionless file | cold | fails: Cannot find package '@helpers/model' | | |
| retest list (head), enum, alias and extensionless file | warm | fails: Cannot find package '@helpers/model' | | |
| retest list (current), erasable file | cold | 169 | 169 | 172 |
| retest list (current), erasable file | warm | 127 | 124 | 127 |
| retest list (current), enum, alias and extensionless file | cold | 181 | 180 | 184 |
| retest list (current), enum, alias and extensionless file | warm | 133 | 132 | 136 |
| retest list (head-source), erasable file | cold | 274 | 265 | 295 |
| retest list (head-source), erasable file | warm | 102 | 100 | 105 |
| retest list (head-source), enum, alias and extensionless file | cold | fails: Cannot find package '@helpers/model' | | |
| retest list (head-source), enum, alias and extensionless file | warm | fails: Cannot find package '@helpers/model' | | |
| retest list (source), erasable file | cold | 332 | 322 | 335 |
| retest list (source), erasable file | warm | 141 | 140 | 142 |
| retest list (source), enum, alias and extensionless file | cold | 337 | 335 | 340 |
| retest list (source), enum, alias and extensionless file | warm | 145 | 142 | 149 |

What the rows say:

- Warm, the route Retest uses costs 26 ms per process on the bare graph (46 ms against 20 ms) and 34 ms on the enum file (54 against 20 for the flag). A split run by hand, seven warm starts each, with no script and no log kept, pointed at where it goes: a hook that only calls the transformer, then lets Node strip and cache as usual, took 46 ms, a hook that strips by itself 45 ms, and no hook 19 ms. That reads as the transformer loading, not the lost compile cache. Under `--experimental-transform-types`, a warm start never loads it.
- Cold, the routes are within a millisecond of each other: 46 against 47 ms on the erasable file, 56 against 55 on the enum file.
- `transpileModule` took 145 ms cold and 84 ms warm on the enum file.
- The built package's erasable file: 152 ms cold and 91 ms warm before, 169 and 127 now, 17 and 36 ms more. That difference also holds other lanes' new modules; the loader's own part is taken to be the 26 ms of the bare-graph row above, by inference, and the rest is not measured apart.
- From source: 274 and 102 ms before, 332 and 141 now, 58 and 39 ms more, with the same caveat.

Two earlier runs, of the first version of this lane, which used `--experimental-transform-types` in the child, gave the built package's erasable file 167/85 ms against 156/88 ms and 186/111 ms against 169/108 ms, cold/warm medians, head first. No measurement used `npm run bench`, and no benchmark was running. All of these timings were taken before the edits the review asked for in `src/loader/project.ts`; they were not run again after them.

## Source locations

`scripts/probe-loader-positions.ts` writes a TypeScript file with an enum and parameter properties, so the transformer rewrites all of it, loads it through the project hooks with `--enable-source-maps` as a test file's process does, and compares 24 sites with where they are written: 19 calls read through `util.getCallSites`, as Retest reads the place of an action or a check, and 5 errors read from their stack, as Retest reads where an error was thrown. The calls sit in statements, declarations, arguments, templates, arrow bodies, optional calls, object values, `await`, an `if`, a callback, enum initializers, a namespace body, constructors with parameter properties and `super`, default parameters and field initializers; the errors in a statement, a `throw`, a constructor, a generic arrow, and after `as` and `satisfies`.

Result: 24 of 24 at their written line and column (`/tmp/retest-loader-positions.txt`). In a probe by hand, with no script and no log kept, seven error sites of the same kinds, run under Node's own `--experimental-transform-types` with no hook, also came out exact. The review saw one column move from 77 to 76; no probe here reproduced it. A file that stripping accepts never depends on a map: stripping replaces types with spaces, so every position is the written one. Only a file with an enum, a namespace with values or a parameter property is transformed, and the consumer test proves its map with lines that genuinely move: the failed check in `support/task-page.ts` runs on line 25 of what Node executes and is reported on its written line 28, and the throw in `support/failures.ts` runs on line 13 and is reported on line 11.

## The choice

Node's transformer, through `module.stripTypeScriptTypes`, in a load hook in both processes (`src/loader/project.ts`, `src/loader/transform.ts`). Types are stripped first, so a file without TypeScript-only syntax keeps its exact positions; a file stripping refuses is transformed with a source map, and source maps are turned on. A test file's process runs with `--enable-source-maps` as its only added flag, the parent's `--conditions` passed through (`src/loader/node.ts`, `src/runner/test-file-process.ts`), and registers the own-package resolve hook and then the project hooks (`src/runner/child-program.ts`), so `util.getCallSites` maps locations. Node's one warning about the function is held back by its text inside the hook; every other warning, including one test code causes, is meant to print, which no test checks: `tests/unit/loader-node.test.ts` compares the flags only.

The first version ran the child with `--experimental-transform-types`, which caches its output and so starts 26 ms faster warm, but transforms every file, erasable ones included, and leaves every position to a map. The review asked for exact positions first; strip first per file gives them, for that warm cost.

Why not `transpileModule`: it is unavailable to a project on TypeScript 7, whose package has no JavaScript compiler API, and to a project that installs no TypeScript, which Retest does not otherwise need. It was the slowest route here, cold and warm, and is never cached. Its real advantages, decorators, JSX and dropping type-only imports, are outside 0.1.0's scope.

What the transformer is and is not, as the guide says it: it removes types and turns enums, namespaces and parameter properties into JavaScript; it does not check types, and `tsc` still does.

## What was built

| File | What it is |
| --- | --- |
| `src/loader/tsconfig.ts` | Finds the nearest `tsconfig.json` and reads it as `tsc` does: JSON with comments and trailing commas, an empty file as `{}`, `extends` to a path, a list or a package (its exports, the file, `.json`, the `package.json` `tsconfig` field, its `tsconfig.json`), `paths` from `baseUrl` or the declaring file, `${configDir}`, `null` resets. A `paths` that is not an object of patterns and lists of paths, or that has more than one `*` in a pattern or a target, is a usage failure naming the file; nothing else `tsc` would refuse in `paths` is checked |
| `src/loader/resolve.ts` | The project resolve hook, grown from `src/runner/playwright-resolve.ts` (removed): the `.ts` beside a `.js` first, extensionless imports, `.`, `..` and folders to their index, `paths` matched as TypeScript matches them, failures that name the governing tsconfig, the JSX file an extensionless import names, and `@playwright/test` only under `--playwright` |
| `src/loader/project.ts` | `useProject`: registers the hooks once per process; caches each folder's nearest tsconfig; reads the entry's tsconfig first; strips or transforms project TypeScript; refuses JSX, and CommonJS in a test file, the config or TypeScript; hints only from the failing file itself. It also keeps `loadedModules()`, the list of project modules and their SHA-256 the replay lane's bundle fingerprint reads |
| `src/loader/transform.ts` | Strip, then transform with a source map; names the file and line the transformer stopped at; the decorator hint, said as "may" |
| `src/loader/node.ts` | The test process flags, the minimum Node read from `engines`, and the probe `doctor` runs: Node with the test process flags transforms a snippet through `transform.ts` and runs it from a data URL, without the project hooks |
| `src/runner/child-program.ts`, `test-file-process.ts` | The child registers the project hooks when it is asked to collect, and starts with the flags above |
| `src/config/load.ts` | The config loads through the same hooks |
| `src/cli/doctor/checks.ts` | A Node line, only when Node is older than 24.12 or cannot run the transformer as the probe does, with the fix |
| `src/cli/init/templates.ts`, `src/cli/commands/init.ts`, `src/cli/init/report.ts` | `init` writes `tests/tsconfig.json`, extending the project's own when there is one, and points `typecheck:e2e` at it |
| `fixtures/consumers/everyday` (with `typescript-7/`), `plain`, `unsupported` | The consumer projects; the root `tsconfig.json` excludes them |
| `tests/integration/consumer-loading.test.ts` | Each fixture copied outside the checkout, the packed package installed, run from its config in Chrome; both compilers on the TypeScript 7 variant and on `init`'s tsconfig |
| `tests/unit/loader-*.test.ts`, `config-load-typescript.test.ts`, `runner-typescript-loading.test.ts`, `cli-init.test.ts` | The reader, the resolution table, the doctor check, the config path, the test file process against the fake browser, and `init` |
| `scripts/measure-loader.ts`, `scripts/probe-loader-positions.ts` | The timings and the position probe above |

## Verification

All on macOS 27.0 arm64 with Google Chrome 154.0.8037.93, in this checkout, after the review. Heavy commands ran under `lockf -t 0 /tmp/retest-heavy-gate.lock`. Other lanes were editing the tree, so the full unit and integration suites were left to the orchestrator.

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test` on this lane's unit files with `playwright-resolve`, `config-load-file`, `cli-doctor`, `cli-init` and `runner-resolve-hook` | 100 of 100 | `/tmp/retest-loader-fix-unit-lane.txt` |
| `node --conditions=retest-source --test tests/integration/consumer-loading.test.ts` | 8 of 8, real Chrome, packed package | `/tmp/retest-loader-fix-consumers.txt` |
| `npm run test:types` | 193 of 193 markers on TypeScript 6.0.3 and on 7.0.2 | `/tmp/retest-loader-fix-types.txt` |
| `npm run typecheck` | Passed: TypeScript 6, TypeScript 7, `examples/tasks` | `/tmp/retest-loader-fix-typecheck.txt` |
| `node --conditions=retest-source scripts/probe-loader-positions.ts` | 24 of 24 sites exact | `/tmp/retest-loader-positions.txt` |

Before the review, a copy of commit `dc95bb6` with the first version of this lane on top passed `npm run test:unit` 1,674 of 1,675 (the one failure was this lane's own outdated message assertion, fixed then, after which its loader files passed 40 of 40), `npm run test:types`, `npm run typecheck` and `npm run test:integration` 320 of 320 (`/tmp/retest-loader-iso-*.txt`). Those runs predate the changes the review asked for.

## What stays unsupported

- CommonJS test files, configs and TypeScript. A `.cts` file, or a test file, a config or a `.ts` file that Node reads as CommonJS and that uses `require()`, `module.exports`, `exports.`, `__dirname` or `__filename`, fails by name. Such a file that uses none of them, such as one with no import or export at all, is left to Node. A CommonJS JavaScript helper, such as a `.cjs` file, and packages in `node_modules` load as Node loads them; the plain fixture imports one.
- JSX, in `.tsx` and `.jsx` files or in `.ts`.
- Decorators. The line in the hint comes from a pattern on the project `.ts` file last handed to Node, which is the failing one as long as Node compiles each module as it loads, so the message says it may be the cause.
- A type imported without `type`. The hint appears only when the TypeScript file imported declares the name as a type or an interface, and says "only as a type" for both; never for a JavaScript file or a package.
- Project references, bare imports looked up from `baseUrl` alone, and every other `tsconfig.json` setting.
- TypeScript inside `node_modules`: Node refuses it.
- A `.ts` file in a package with no `"type"` that needs the transformer is read as an ES module unless it uses a CommonJS name and has no import or export: Node's own detection strips types first and cannot read such a file.
- `tsc -p tests/tsconfig.json` is expected to accept a decorator and a `require()` call, which Retest refuses, and to refuse `import x = require()` and a type imported without `type`; none of the four was run through `tsc`. The consumer test runs TypeScript 6 and 7 on the project's own constructs and on a JSX file only.

## What remains unverified

Paths the code has and no test exercises, or that only a unit test does:

- The positions of a file stripping accepts, which has no map: the plain consumer loads such a test file and passes, and no check reads a location in it.
- A `.mts` or `.mjs` file as the test file or the config: `clock.mts` and `format.mjs` are helpers only.
- A `.cts` file as the test file or the config: `legacy.cts` is a helper, refused by its extension.
- `module.exports`, `exports.`, `__dirname` or `__filename` in a `.ts` file Node reads as CommonJS: the pattern matches all five names, and only `require()` was run.
- A `.ts` helper, not the entry, that Node reads as CommonJS.
- The guessed-format branch, a `.ts` file in a package with no `"type"` that needs the transformer (`src/loader/project.ts`, `loadWithFormat` and `commonJsConstruct`).
- A `.jsx` file: only `.tsx` was run.
- A tsconfig that extends itself directly: the unit test runs a cycle of two files.
- The config under a tsconfig nearer than the root one: the nearer tsconfig was run for a test file only.
- `extends` to a package: unit tests only; the consumers extend a file.
- `findTsconfig` in `src/loader/tsconfig.ts` is called by tests only; a run finds the nearest tsconfig through `nearestTsconfig` in `src/loader/project.ts`, which caches by folder.

## Open

- `doctor` shows Node only when it fails. Showing a passing line changes `src/cli/commands/doctor.ts`'s table and the exact outputs in `tests/unit/cli-doctor.test.ts`, and adds an entry to the checks `tests/unit/runner-target-drivers.test.ts` compares whole; all three belong to other lanes.
- The command line crashes on a Node too old to run it before `doctor` can say so. That predates this lane.
- The consumer projects ran on macOS arm64 only.

## Sources and licenses

- Node.js 24.12.0, MIT: [TypeScript](https://nodejs.org/docs/latest-v24.x/api/typescript.html), [`module.stripTypeScriptTypes`](https://nodejs.org/docs/latest-v24.x/api/module.html), [`--experimental-transform-types`](https://nodejs.org/docs/latest-v24.x/api/cli.html). amaro 1.1.5, MIT, bundled in Node; SWC, Apache-2.0, inside amaro. Used through Node's public API; nothing copied.
- TypeScript 6.0.3 and 7.0.2, Apache-2.0, this repository's dev dependencies: `transpileModule` called from a measurement hook, TypeScript 7's exports read, and both compilers run on the fixtures. Nothing copied, and neither becomes a runtime dependency.
- The `paths` matching rules (exact pattern first, then the longest prefix, at most one `*`) and the `extends` package lookup follow TypeScript's documented behaviour; the code is original.
