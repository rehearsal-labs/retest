# Retest 0.1.0 capability inventory

Written 3 October 2026 for Phase 1 item 1 of [the 0.1.0 handoff](release-0.1.0.md). It marks every row of "The complete 0.1.0 scope", plus the Playwright adapter and the CLI, against the tree at HEAD `73b098b` and the contract lane's changes on top of it.

- **Existing, verified**: implemented, and the named tests exercise it. The baseline gates on the untouched tree were green (1,639 unit, 141 type markers, 314 integration against real Chrome; see [progress.md](progress.md)). Unit tests run against a fake browser or a scripted CDP session; integration tests run real Chrome.
- **Needs changes**: implemented in part. The entry says what is missing.
- **Missing**: no implementation in `src/`. Work in progress under `proofs/`, `media/` or `src/media/` by other lanes is named but does not count.

Paths are relative to the repository root. `unit/`, `integ/` and `types/` stand for `tests/unit/`, `tests/integration/` and `tests/types/fixtures/`.

## What the contract lane added

These changes land with this inventory and are referred to below.

- The session and capability contract in `src/browser/contract.ts`: `TargetKind`, `WebEngine`, `DriverName`, runtime and session identity, `InputDispatch` and `DispatchedCommand`, `ObservationScope`, `Session`, and the web capabilities (`NavigationCapability`, `StorageStateCapability`, `ContextCapability`, `WebSession`, `WebRuntime`), exported as types from `@rehearsal-labs/retest/runner`. `ChromiumBrowser` is a `WebRuntime` with an `identity`; `ChromiumPage` is a `WebSession` whose `dispatch` says how far each command's input events got, a click's mouse move included. `Observation` gained `checked` and `enabled`, required of every driver, so a launcher a host wrote against the earlier contract fails typecheck until it supplies them; run folders are unaffected, since the recorded observation keeps them optional. `not_sent` means no input event went, not that nothing changed: the readiness look may already have focused the element, selected a field's text or scrolled the element into view, and the page's focus, blur and scroll handlers run on those. `OwnedBrowser`, `OwnedPage` and `launchBrowser` are unchanged for callers. Proven by `unit/browser-input-dispatch.test.ts` and `integ/session-contract.test.ts`.
- The native capabilities as types in `src/browser/contract.ts` only: `AppLifecycleCapability` (install, launch, activate and terminate, each bounded, stoppable by a signal and answering with its failure and how far the request got; app state; `ResetPolicy`), `GestureCapability`, `NativeSession`, `NativeRuntime`. Nothing implements them, so no public subpath exports them.
- Session ids: `formatSessionId(attemptId, app)` in `src/protocol/evidence.ts`. `observation`, `evidence.captured` and `evidence.failed` carry `sessionId`; a screenshot's event and result entry carry `sessionId`, `attemptId` and `capturedAt` (`EvidenceReference`). A look's reference is its id and its session: the test process receives both with the look and sends both back with the assertion, and the parent refuses one whose session did not serve that look, as when a process replays a look from an earlier attempt (`src/runner/observations.ts`). An assertion that sends a look's id without its session is refused as a protocol violation, as one that sends a session without an id is. Proven by `unit/runner-session-evidence.test.ts` and `unit/runner-page-looks.test.ts`.
- Targets: the config accepts `{ browser: 'firefox' }`, `{ browser: 'webkit' }`, `{ platform: 'ios-simulator', appPath, device, runtime }` and `{ platform: 'macos', appPath }`. Once a run has planned, every attempt that needs one ends `not_run` with `setup_failed`, naming its target (`src/runner/target-drivers.ts`, `RunSession.#refuseUndriven`). It starts no server and launches no browser, and it takes no share of the browsers the rest are spread over; the other attempts run. `doctor` refuses the same targets by name. The test-side types give a native app a `NativePage` with no `goto`. Proven by `unit/runner-target-drivers.test.ts`, `types/native-targets/register.ts` and `types/native-config.ts`.
- `schemaVersion` stays 1. The new event and result fields are optional, so a reader built from this tree accepts run folders written before them. It does not work the other way: objects reject unknown keys, so a reader built from HEAD `73b098b` refuses a new folder's `sessionId` and `capturedAt`, as earlier readers refused milestone 3's `cause` and `document`.

## Targets

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Chrome/Chromium on macOS arm64 | Existing, verified | `src/browser/launch.ts`, `browser.ts`, `page.ts`, `chromium-process.ts`, `executables.ts` | `integ/browser-launch.test.ts`, `integ/m2-matrix.test.ts` (two Chromium builds), every other integration test, `unit/browser-executables.test.ts` |
| Edge | Needs changes | `src/browser/executables.ts` | Code paths exist and are unit tested (`unit/browser-executables.test.ts`); Edge was never run (guide, "What Retest does not do yet") |
| Firefox on macOS arm64 | Missing | config accepted, attempts refused at planning: `src/config/read-apps.ts`, `src/runner/target-drivers.ts` | No driver. A BiDi proof is under review in `proofs/firefox/` |
| WebKit on macOS arm64 | Missing | as Firefox | No driver. A proof is under review in `proofs/webkit/`; it uses Playwright's WebKit build, which needs a founder decision on notices before `retest install` ships it |
| Native iOS simulator apps | Missing | config accepted, attempts refused at planning | No driver. `proofs/native/` started; no simulator runtime is installed on the machine |
| Native macOS apps | Missing | config accepted, attempts refused at planning | No driver. `proofs/native/` started |
| Chrome/Chromium on Linux x64 | Needs changes | code is platform-neutral; `.github/workflows/ci.yml` has a manual Linux x64 job | Verified only on Linux arm64 in Docker (`docker/linux/run.sh`). The guide says Linux x64 was never run |

## Navigation

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Absolute URL | Existing, verified | `src/api/app-page.ts` `goto`, `src/browser/navigation.ts` | `integ/browser-navigation.test.ts` "goto accepts a full URL without a base URL" |
| Relative URL | Existing, verified | `src/browser/navigation.ts` resolves against the app's `baseUrl` | `integ/browser-navigation.test.ts` "goto resolves against the base URL…", "a relative address without a base URL is a usage failure" |
| Reload | Missing | | No `Page` member and no CDP call. Under `--playwright`, `page.reload` is refused by name by the guard |
| Back | Missing | | |
| Forward | Missing | | |
| URL observation | Needs changes | `src/browser/page-url.ts`, `src/runner/page-navigations.ts`, host `address` check in `src/protocol/host-check.ts` | Recorded in `navigation` events, `pageUrl` and host checks (`integ/browser-navigation.test.ts`, `unit/browser-page-url.test.ts`, `integ/m3-host-checks.test.ts`). Missing: a test-facing `page.url()` and `toHaveURL` |
| Title observation | Needs changes | `src/browser/navigation-titles.ts` | Recorded in `navigation.title`, `pageTitle` and host checks (`unit/browser-titles.test.ts`, `integ/m3-titles.test.ts`). Missing: `page.title()` and `toHaveTitle` |
| Ordinary navigation waits | Needs changes | `src/browser/navigation.ts`, `actionability.ts` | `goto` waits for `load` and follows a client redirect; actions wait out a pending navigation (`integ/browser-navigation.test.ts`, `unit/browser-actionability.test.ts`). Missing: `waitForURL`, `waitForLoadState`, a `waitUntil` option |

## Locators

The recipe is flat (`src/protocol/locator.ts`): `testId`, `role`, `label`, `text`. Matching is in `src/browser/locate.ts`, `element-queries.ts`, `accessibility.ts`, `text-match.ts`, top-level document only.

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Test id | Existing, verified | `src/api/locator-recipes.ts` `testIdRecipe` | `integ/browser-actions.test.ts` "a test id matches exactly…", `unit/browser-locate.test.ts`, `types/registered/register.ts` |
| Role/name | Existing, verified | `roleRecipe`, `Accessibility.queryAXTree` | `integ/browser-locators.test.ts`, `integ/m2-locators.test.ts`, `unit/browser-accessibility.test.ts`, `types/aria-role.ts` |
| Label | Existing, verified | `textRecipe('label')` | `integ/browser-locators.test.ts` "label finds a form control by each source of its name…", `integ/m2-locators.test.ts` |
| Text | Existing, verified | `textRecipe('text')` | `integ/browser-locators.test.ts`, `unit/browser-text-match.test.ts` |
| Placeholder | Missing | | No `getByPlaceholder`; a placeholder is found only when Chrome uses it as the accessible name. Refused by name under `--playwright` |
| CSS | Missing | | No `locator()`; `page.locator` refused under `--playwright` with a hint |
| Scoped lookup | Missing | | `Locator` has no `getBy*` methods; recipes are flat, so composition needs a recipe schema change |
| first / last / nth | Missing | | Refused under `--playwright` with a hint (`unit/playwright-compat.test.ts`) |
| Strict matching | Existing, verified | actions and single-element matchers | `integ/browser-locators.test.ts` "a role that matches more than one element fails an action at once", `integ/browser-actions.test.ts` "two elements with the test id fail as ambiguous…" |
| Exact option | Existing, verified | default `exact: true`; `exact: false` is a case-insensitive part | `integ/browser-locators.test.ts` "exact: false matches any case…", `unit/api-handles.test.ts` |
| Regex option | Missing | | Strings only; anything else is a usage failure in `locator-recipes.ts` |

## Browser input

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Click | Existing, verified | `src/browser/page.ts`, `input.ts`, `input-guard.ts` | `integ/browser-actions.test.ts` (overlay, hidden, disabled, moving, below the fold, trusted press and release), `integ/session-contract.test.ts` |
| Hover | Missing | | |
| Fill | Existing, verified | `replaceSelection` | `integ/browser-actions.test.ts`, `integ/browser-secrets.test.ts` |
| Keyboard press | Needs changes | `src/browser/keys.ts`, `src/protocol/keys.ts` | One key, `Shift+` a named key, one character (`integ/m3-press.test.ts`, `unit/browser-keys.test.ts`, `types/keys.ts`). Missing: Control, Alt, Meta; held keys; typing key by key |
| Select | Needs changes | `applySelection` | Works (`integ/m3-actions.test.ts`, `unit/browser-select.test.ts`), but it sets the choice by script, so `input` and `change` are untrusted; not real input |
| Check / uncheck | Existing, verified | `checked-state.ts` | `integ/m3-actions.test.ts`, `unit/browser-check.test.ts`, `types/actions.ts` |
| Scroll | Existing, verified | `wheelAt` | `integ/m3-actions.test.ts`, `unit/browser-scroll.test.ts` |
| Real input with actionability | Existing, verified | `actionability.ts`, `input-guard.ts` | `unit/browser-actionability.test.ts`, `unit/browser-input-guard.test.ts`; select is the exception above |
| Input dispatch state on cancel and loss | Needs changes | `src/browser/dispatch.ts`, `ChromiumPage.dispatch` | Chromium reports it through `dispatch` (`unit/browser-input-dispatch.test.ts`, `integ/session-contract.test.ts`). The runner calls `execute`, so no event or result records the state yet; failures keep `details.inputSent` as before |

## Assertions

`Observation` (`src/protocol/commands.ts`) carries `count`, `visible`, `text`, `value` and `items`; it has no enabled or checked state, so those matchers need it extended.

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| toBeVisible / toBeHidden | Existing, verified | `src/assertions/expect.ts`, `src/protocol/locator-checks.ts` | `unit/assertions-matchers.test.ts`, `integ/m2-matchers.test.ts`, `types/matchers.ts` |
| toHaveText | Existing, verified | whole text, normalised spaces, or a list | `unit/assertions-text.test.ts`, `integ/m2-matchers.test.ts` |
| toContainText | Missing | | Refused under `--playwright` |
| toHaveValue | Existing, verified | | `unit/assertions-matchers.test.ts`, `integ/m2-matchers.test.ts` |
| toHaveCount | Existing, verified | | `unit/assertions-matchers.test.ts`, `integ/m2-matchers.test.ts` |
| toBeChecked | Missing | | The page reads checked state only inside check/uncheck |
| toBeEnabled / toBeDisabled | Missing | | |
| toHaveURL / toHaveTitle | Missing | | Host checks read them, not tests |
| Negation (`.not`) | Missing | | Refused under `--playwright` |
| Regex matching | Needs changes | value `toMatch(RegExp)` only | Locator matchers take strings only |
| Value assertions | Existing, verified | `toBe`, `toEqual`, `toContain`, `toMatch` | `unit/assertions-matchers.test.ts`, `unit/assertions-deep-equal.test.ts` |
| Soft assertions | Existing, verified | `expect.soft` | `unit/assertions-soft.test.ts`, `integ/m2-matchers.test.ts` |
| Polling | Existing, verified | change-driven looks, `expect.poll` | `unit/assertions-poll.test.ts`, `unit/runner-observations.test.ts`, `integ/m3-observations.test.ts` |
| Parent re-judges locator assertions | Existing, verified | `src/runner/observations.ts` | `unit/runner-observations.test.ts`, `unit/runner-session-evidence.test.ts` |

## AI evaluation

Missing in full: text, screenshot and frame-sequence evidence; named evaluators; a provider-agnostic interface; the optional AI SDK adapter; host credential sources; required and advisory checks; inconclusive and error outcomes; budget limits. Only the `inconclusive` status and count exist in `src/protocol/events.ts`, and nothing produces them. Design: [ai-evaluation.md](ai-evaluation.md).

## Test API

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| test | Existing, verified | `src/api/test.ts`, `declare.ts` | `unit/api-registration.test.ts`, `unit/api-test-run.test.ts`, `types/public-api.ts` |
| describe | Existing, verified | | `unit/api-registration.test.ts`, `integ/m2-hooks.test.ts` |
| step | Existing, verified | | `unit/api-test-run.test.ts`, `integ/cli-commands.test.ts` |
| beforeEach / afterEach | Existing, verified | | `unit/api-hooks.test.ts`, `integ/m2-hooks.test.ts` |
| Parameterized tests | Existing, verified | `test.for` | `unit/api-registration.test.ts`, `integ/m2-selection.test.ts`, `types/registered/register.ts` |
| skip / only | Missing | | Refused under `--playwright` |
| forbid-only in CI | Missing | | No CI detection; only coding-agent detection in `src/cli/agent-detection.ts` |
| Test timeout | Existing, verified | `timeout` option, `timeouts.test`, `--timeouts` | `integ/m2-guarantees.test.ts`, `unit/runner-lifecycle.test.ts`, `integ/matrix-lifecycle.test.ts` |
| Action timeout | Needs changes | `action` and `navigation` budgets | Budgets work (`unit/runner-lifecycle.test.ts`); no per-call option |
| Assertion timeout | Needs changes | `assertion` budget, `expect.poll({ timeout })` | `unit/assertions-expect.test.ts`; no per-call option on locator matchers |
| Evaluation timeout | Missing | | |

## Configuration

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Discovery | Existing, verified | `src/shared/test-files.ts`, `src/cli/test-files.ts` | `unit/cli-run-config.test.ts`, `integ/m2-config.test.ts` |
| Filtering | Existing, verified | `--grep`, `--tag`, `file:line#row`, `--last-failed` | `unit/runner-selection.test.ts`, `unit/cli-tag-expression.test.ts`, `integ/m2-selection.test.ts` |
| Target selection | Existing, verified | `--target app=name` | `integ/m2-matrix.test.ts`, `unit/runner-config-apps.test.ts` |
| Browser projects | Existing, verified | apps with several targets, `runs` | `integ/m2-matrix.test.ts`, `unit/runner-variants.test.ts`. Chromium family only; attempts on other engines are refused at planning |
| Target config for Firefox, WebKit, iOS, macOS | Existing, verified (accept and refuse only) | `src/config/types.ts`, `read-apps.ts`, `src/runner/target-drivers.ts` | `unit/runner-target-drivers.test.ts`, `types/native-config.ts` |
| Base URL | Existing, verified | app `baseUrl`, `--base-url` | `integ/m2-config.test.ts`, `unit/cli-run-config.test.ts` |
| Viewport | Needs changes | `emulate` | Only through a device or a custom emulation (`integ/browser-emulation.test.ts`, `unit/config-devices.test.ts`); no standalone `viewport` key |
| One app-server command with readiness and cleanup | Existing, verified | `src/runner/app-server.ts`, `app-servers.ts` | `unit/runner-app-server.test.ts`, `integ/m2-servers.test.ts` |

## Authentication

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Fresh browser contexts | Existing, verified | one context per app per attempt | `integ/browser-lifecycle.test.ts` "each page starts with empty storage and cookies", `integ/matrix-lifecycle.test.ts` |
| Cookies and local storage | Existing, verified | `src/browser/storage-state.ts` | `integ/browser-state.test.ts`, `unit/browser-storage-state.test.ts`. `sessionStorage` is not saved; no test-facing cookie API |
| Reusable signed-in state | Existing, verified | `test.setup`, `state` | `integ/m2-state.test.ts`, `unit/runner-config-state.test.ts` |
| Host-controlled secrets | Existing, verified | `src/runner/secrets.ts`, `redactor.ts` | `unit/runner-secrets.test.ts`, `integ/m2-secrets.test.ts`, `integ/browser-secrets.test.ts` |

## Web participants

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Predeclared named participants, separate contexts and pages | Existing, verified | apps in the config, `apps: ['owner', 'member']` | `integ/m2-apps.test.ts`, `unit/runner-config-apps.test.ts` |
| Separately authenticated participants | Needs changes | `state: { owner: 'a', member: 'b' }` | Planned and unit tested (`unit/runner-plan.test.ts`); no end-to-end test signs in two accounts |
| Two-account reference workflow | Missing | | |
| Four-session isolation gate | Missing | | |
| Owner and host session limits | Missing | | |

## Scheduling

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| File workers | Existing, verified | `src/runner/workers.ts` | `unit/runner-workers.test.ts`, `unit/runner-parallel.test.ts` |
| Browser pooling | Existing, verified | `src/runner/browser-pool.ts` | `unit/runner-browser-pool.test.ts` |
| Explicit worker limit | Existing, verified | `--workers`, `--browsers` | `unit/cli-run.test.ts`, `unit/runner-parallel.test.ts`; no integration run passes the flags |
| Acquire every app before acting | Existing, verified | `RunSession.#prepare`, `#openPages` | `integ/m2-apps.test.ts`, `unit/runner-config-apps.test.ts` |
| Resource reservations | Missing | | |
| Device and desktop leases | Missing | | |
| Shared-state locks | Missing | | `src/api/command-lanes.ts` serializes commands per app; it is not a lock |

## Reproduction and replay

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Distinct owned sessions | Existing, verified | a context per app per attempt; `sessionId` from `formatSessionId` | `unit/runner-session-evidence.test.ts`: a look's reference carries its session, one replayed from an earlier attempt is refused, and one that sends no session is refused |
| Run, test, variant, attempt identities | Existing, verified | `runId` (`randomUUID`), `testId`, `variantKey`, `attemptId` (`src/runner/attempt-id.ts`) | `unit/runner-process.test.ts`, `unit/protocol-variant.test.ts` |
| Bounded trusted-host preparation and cleanup | Missing | | Only host checks after the body (`src/runner/run-host-checks.ts`) and app-server start and stop |
| Declared starting-state policy | Needs changes | `state` option, `state.restored` | No policy record |
| Executed-bundle and configuration identity | Missing | | `run.started` records version, files, config path and timeouts; no fingerprints |
| Requirement identity and stable required-check ids | Missing | | Host checks have an optional `name`; observation ids count within an attempt |
| Attempt-bound evidence | Existing, verified | screenshot names carry the attempt; references carry session, attempt and time | `unit/run-folder.test.ts`, `unit/runner-session-evidence.test.ts` |

## Native lifecycle, interaction and checks

Missing in full. `src/browser/contract.ts` declares the lifecycle (`AppLifecycleCapability`: install, launch, activate and terminate, each bounded, stoppable and answering with its failure and how far the request got; app state; `ResetPolicy`) and gestures (`GestureCapability`) as types. Nothing implements them, and no public subpath exports them. The test-side types give native apps `NativePage` and `NativeLocator`, with no `goto`, `select`, `check` or `uncheck`, `tap()` on iOS and `click()` on macOS; a run refuses every test that needs a native target, so no test body receives one. Native locators, input, checks, dialogs, keyboard handling, crash detection and the reset documentation all remain.

## Cross-platform tests

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Acquire all apps before acting | Existing, verified for web apps | `RunSession.#prepare`, `#openPages` | `integ/m2-apps.test.ts` |
| Share ordinary test data | Existing, verified for web apps | one test function holds every app | `unit/api-handles.test.ts`, `integ/m2-apps.test.ts` |
| Wait for asynchronous sync | Existing, verified | locator polling, `expect.poll` | `unit/assertions-poll.test.ts` |
| One result across apps | Existing, verified for web apps | one result per variant, a screenshot per app | `integ/m2-apps.test.ts`, `unit/runner-session-evidence.test.ts` |
| Native apps in the flow | Missing | | Refused at planning until drivers exist; a test on a web and a native app launches nothing (`unit/runner-target-drivers.test.ts`) |

## TypeScript

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Shipped JavaScript and declarations | Existing, verified | `tsconfig.build.json`, exports map | `integ/package-smoke.test.ts` |
| Typed names and capabilities | Existing, verified | `src/config/register.ts`, `src/api/apps.ts` | all of `types/`, now with `types/native-targets/register.ts` and `types/native-config.ts`; `integ/m2-package.test.ts`, `integ/m3-package.test.ts` |
| ESM tests and configuration | Existing, verified | Node type stripping | `integ/m2-config.test.ts`, `integ/package-smoke.test.ts` |
| Imported helpers | Existing, verified with explicit `.ts` extensions | `src/runner/own-package.ts` | `unit/runner-resolve-hook.test.ts` |
| Extensionless imports | Needs changes | `src/runner/playwright-resolve.ts` | Only in `--playwright` runs (`unit/playwright-resolve.test.ts`) |
| Source maps | Missing | | No `--enable-source-maps` for the child; the build emits declaration maps only. Locations are right today because type stripping keeps positions |
| Basic path aliases | Missing | | No `tsconfig` reading |
| Transform path for enums and parameter properties | Missing | | Erasable syntax only |
| TypeScript 6 and 7 consumer checks | Existing, verified | `package.json` `typecheck`, `tests/types/run.ts` | `npm run typecheck`, `npm run test:types`, `integ/package-smoke.test.ts` |

## Rust media

Missing from `src/`. Another lane has an untracked crate in `media/` (frame protocol, bounded queue, timeline, scaling, ffmpeg probe) and a client in `src/media/`; it is in progress and not wired in. Frame queues, timestamps, resizing, thumbnails, video assembly, finalization and media failure status all remain. The only capture today is `Page.captureScreenshot` for failures.

## Evidence

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Screenshots | Needs changes | `src/runner/test-pages.ts` | Failure screenshots only, one per app, each with an `EvidenceReference` (`integ/m2-apps.test.ts`, `unit/runner-session-evidence.test.ts`). Not redacted; no screenshot on a passing step |
| Playable recordings | Missing | | |
| Source locations | Existing, verified | `src/reporters/code-frame.ts` | `unit/reporters-human.test.ts` |
| Expected and actual values | Existing, verified | assertion events, `src/reporters/diff.ts` | `unit/reporters-human.test.ts`, `unit/assertions-expect.test.ts` |
| Action and check timeline | Existing, verified | `events.jsonl`, `inspect --test` | `unit/inspect-timeline.test.ts`, `unit/inspect-command.test.ts` |
| AI criterion verdicts | Missing | | |
| JSONL | Existing, verified | `src/runner/event-log.ts` | `unit/runner-event-log.test.ts`, `integ/matrix-reporting.test.ts` |
| HTML | Missing | | |
| Interrupted runs stay inspectable | Existing, verified | `src/store/rebuild-result.ts` | `unit/store-read-run-folder.test.ts`, `integ/matrix-reporting.test.ts`, `unit/runner-session-evidence.test.ts` (references survive a rebuild) |

## Diagnostics

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Console messages | Missing | | No `Runtime.consoleAPICalled` subscription |
| Uncaught errors | Needs changes | `src/runner/child-program.ts` | Test-process errors are captured (`unit/runner-lifecycle.test.ts`); page exceptions are not |
| Request and response metadata, timing | Missing | | `Network.enable` is used only in `src/browser/origin-document.ts` |
| Redirects | Needs changes | navigation causes | Main-frame navigations only; no HTTP redirect hops |
| Transport failures | Needs changes | `src/browser/navigation.ts` | `net::ERR_*` appears in `goto` failures; no network records |
| Native log and network sources, capture status, bounded artifacts | Missing | | |

## Agent sessions

Missing as an API: open, observe, act, state, frame and close; named ownership; capacity limits. The building blocks are typed inside the package: `launchBrowser` (not exported from any subpath) returns a `WebRuntime`, its pages are `WebSession`s whose `dispatch` reports input dispatch state, and `ObservationScope` states the reference rule. `@rehearsal-labs/retest/runner` exports these types; a host's launcher still returns an `OwnedBrowser`. Two `runFiles` calls can run at once (`integ/m3-concurrent-runs.test.ts`).

## Rehearsal

Inside this repository: the host surface (`runFiles`, `hostChecks`, `testEnvironment`, a `signal` with a `Failure` reason, `readRunFolder`) and the reference host `examples/host/host.ts` (`integ/m3-host-run.test.ts`). `.github/workflows/promote.yml` refuses while `package.json` is `private`. Discovery, codification, verification, AI judgment, diagnostic artifacts and live frames on the Retest path are Rehearsal work, not inventoried here.

## Developer setup

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| Quick start | Existing, verified | README, guide, `init` | `unit/cli-init.test.ts` |
| Pinned browser installation | Missing | | No `retest install` |
| doctor | Existing, verified | `src/cli/doctor/checks.ts` | `unit/cli-doctor.test.ts`, `integ/m2-doctor.test.ts`; refuses targets with no driver (`unit/runner-target-drivers.test.ts`) |
| Platform prerequisite checks | Needs changes | `src/browser/start-failure.ts` | Launch failures are explained; `doctor` checks no Node version, OS, Xcode or simulator runtime |
| Actionable setup errors | Existing, verified | | `unit/browser-executables.test.ts`, `integ/browser-launch.test.ts`, `unit/browser-start-failure.test.ts` |

## Playwright adapter

`src/playwright/`, active only under `--playwright` (`src/runner/playwright-resolve.ts`).

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| `test`, `test.describe`, `beforeEach`, `afterEach`, `test.step`, the `page` fixture | Existing, verified | `src/playwright/test.ts` | `unit/playwright-compat.test.ts`, `integ/playwright-compat.test.ts` |
| `page.goto`, `getByTestId`, `getByRole`, `getByLabel`, `getByText`, `keyboard.press`; `fill`, `click`, `press`, `check`, `uncheck` | Existing, verified | guarded Retest objects | `unit/playwright-compat.test.ts`, `integ/playwright-compat.test.ts` |
| `expect` matchers Retest has, `expect.soft`, `expect.poll` | Existing, verified | `src/playwright/expect.ts` | `unit/playwright-compat.test.ts` |
| Unsupported members fail by name | Existing, verified | `src/playwright/not-yet.ts` | `unit/playwright-compat.test.ts`; hints for `first`, `nth`, `last`, `selectOption`, `type`, `pressSequentially`, `page.locator`, `waitForTimeout` |
| Unsupported options fail by name | Needs changes | `guard()` passes every argument on | `goto(url, options)`, `click(options)`, `fill(value, options)`, `press(key, options)` and `test.step`'s third argument are dropped without a word. No test covers it |
| Playwright's locator defaults | Needs changes | | Playwright's `getByText` and `getByLabel` match a case-insensitive part by default; the adapter keeps Retest's exact default |
| Default timeouts | Needs changes | | Retest's test budget is 60 s and its action budget 10 s; Playwright's test default is 30 s with no action timeout |
| `playwright.config.ts` mapping | Missing | `src/playwright/config.ts` returns its argument | The file is never read |
| Same-case compatibility table | Missing | | |

## CLI

| Capability | Status | Where | Proven by, or what is missing |
| --- | --- | --- | --- |
| `run` with `--config`, `--browser`, `--base-url`, `--grep`, `--tag`, `--target`, `--last-failed`, `--reporter`, `--output`, `--timeouts`, `--workers`, `--browsers`, `--playwright`, `--headed`, `--agent`, `--no-agent` | Existing, verified | `src/cli/commands/run.ts` | `unit/cli-run.test.ts`, `unit/cli-run-config.test.ts`, `integ/cli-commands.test.ts`. `--headed` was never run with a window |
| `list` with selection flags and `--json` | Existing, verified | `src/cli/commands/list.ts` | `unit/cli-list.test.ts`; no published schema for `--json` |
| `inspect` with `--json`, `--test`, `--target` | Existing, verified | `src/cli/commands/inspect.ts` | `unit/inspect-*.test.ts` |
| `init` with `--app`, `--start`, `--browser`, `--ci github`, `--yes` | Existing, verified | `src/cli/commands/init.ts` | `unit/cli-init.test.ts`. `--browser` offers Chromium, Chrome and Edge only |
| `doctor` with `--config` | Existing, verified | `src/cli/commands/doctor.ts` | `unit/cli-doctor.test.ts`, `integ/m2-doctor.test.ts` |
| Exit codes 0, 1, 2, 130, 143 | Existing, verified | `src/runner/outcome.ts`, `src/cli/interrupt.ts` | `unit/cli-run.test.ts`, `integ/run-interrupt.test.ts`, `integ/matrix-reporting.test.ts`, `integ/m2-guarantees.test.ts` |
| `install`, `--project`, `--retries`, `--watch`, JUnit and HTML reporters | Missing | | `unit/cli-help.test.ts` asserts they are absent |

## Deferred by the contract lane

- **Dispatch state in `action.failed`.** Only `dispatch()` reports it, and the runner calls `execute()`. Recording it on the event is an additive field, left for the lane that needs it (agent sessions or replay).
- **A generic session provider.** The pool asks `targetDriver` for each target and keeps Chromium's launch and executable lookup. How a provider locates what it starts and decides what to share is left to the second real driver to settle.
- **Document-generation reporting.** Chromium enforces the generation inside the page and does not report it; reporting it needs a field on observe results, which the agent-session work that acts on element references should add.
- **Native locator recipes.** `NativePage` reuses the web locator recipe and ARIA roles; accessibility identifiers, native roles and their platform mappings come with the native drivers.
- **Recordings as evidence.** `EvidenceReference` has one kind, `screenshot`; recordings arrive with the media pipeline.
- **A look's id sent without its session.** Now enforced: `src/runner/observations.ts` refuses a locator or page assertion that names a look without the session that served it, passed or failed, as a protocol violation. Retest's own test process always sent both; the simulated test processes in the unit tests and the two forged-assertion files now send both too. Proven by `unit/runner-session-evidence.test.ts` and `unit/runner-page-looks.test.ts`.
