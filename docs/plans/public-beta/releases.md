# Retest scope for the first two releases

Updated 3 October 2026. Release 1 is Retest 0.1.0. Release 2 has the proposed version 0.2.0. Everything assigned to a release is planned work, not a claim that it works today.

Release 1 makes the basic product useful across Chrome, Firefox, WebKit, native iOS simulator apps and native macOS apps. It includes isolated reproduction/replay, model-agnostic AI evaluation, console/network diagnostic output and the Rust media processor so Rehearsal adopts the full pipeline from the start. Release 2 expands everyday workflow coverage to a measured target of 80%. Prioritize login, forms, lists, navigation and cross-platform state changes before infrastructure features such as sharding.

This document defines the boundary between the releases. Implement 0.1.0 using the [five-phase scope and implementation handoff](release-0.1.0.md). The [public beta plan](plan.md) remains the combined architecture reference. Its broader future features do not enlarge 0.1.0.

## The release boundary

| | Release 1 version 0.1.0 | Release 2 proposed 0.2.0 |
| --- | --- | --- |
| Purpose | A small, reliable cross-platform testing product | Support most ordinary application-testing workflows in the chosen coverage set |
| Targets | Chrome/Chromium, Firefox, WebKit, native iOS simulator apps and native macOS apps | The same targets, with broader capabilities and host coverage |
| Main example | Create a task in iOS, edit it on the web, verify it on macOS, with recorded evidence | The same flow with richer setup, files and multiple pages/windows |
| Browser adoption | A documented Playwright subset for straightforward tests | Fixtures and surrounding APIs needed by more existing Playwright suites |
| Evidence | Rust screenshots/video, action/check timeline, console/runtime errors, network metadata, AI criterion verdicts, JSONL and HTML | Additional attachments and JUnit |
| AI evaluation | Configurable text, screenshot and recorded-frame checks, caller credentials, required/advisory policy and explicit uncertainty/errors | Broader modes or judge strategies only after their own scoped acceptance checks |
| Replay | Isolated sessions, bounded host preparation/cleanup, executed test/configuration/requirement identity, stable required-check IDs and attempt-bound evidence | Broader state restoration only under separately verified contracts |
| Coverage gate | Every mandatory basic workflow works; no percentage claim yet | At least 80% of the fixed everyday browser cases on each browser, plus separate native gates |
| Rehearsal | Its advertised web discovery and test lifecycle use the pinned engine and Rust media pipeline | Native execution hosts and product support for the native workflows Rehearsal advertises |

Keeping all five targets in Release 1 means the first release still includes substantial driver work. The scope cut is in feature breadth. Firefox, WebKit or a native target cannot be called supported because only its launch operation works.

## Release 1

### Browser scope

Support these behaviors on all three browser engines. Native app APIs expose their corresponding capabilities rather than browser-only methods.

| Area | Included in Release 1 |
| --- | --- |
| Navigation | Relative/absolute URLs, reload, browser back/forward, URL/title observations and ordinary navigation waits |
| Locators | Test ID, role/name, label, text, placeholder and CSS; scoped lookup, first/last/nth; strict matching and the supported exact/regex options |
| Actions | Click, hover, fill, keyboard press, select options, check/uncheck and scroll; real input with actionability checks |
| Assertions | Visible/hidden, text/contain text, value, count, checked, enabled/disabled, URL/title; negation, regex where applicable, value assertions, soft assertions and polling |
| AI checks | Named evaluator configuration, text/screenshots/recorded-frame checks, host credential sources, bounded budgets and required/advisory results |
| Diagnostic output | Page console messages, uncaught errors, request/response metadata, redirects, timings and transport failures; bounded artifacts and capture status |
| Test structure | Tests, suites, steps, beforeEach/afterEach, parameterized tests, skip/only, forbid-only in CI and bounded test/action/assertion/evaluation timeouts |
| Basic configuration | Test discovery, filtering, target selection, browser projects, base URL, viewport and one app-server command with readiness and cleanup |
| Authentication | Fresh browser contexts per test, cookies/local storage, reusable signed-in state and declared secrets |
| Web participants | Predeclared named participants with independently authenticated contexts/pages; two-account workflow and four-session isolation gate; configurable owner/host limits |
| Scheduling | Existing file workers and browser pooling, explicit worker limit, resource reservations and shared-state locks |
| Failure handling | Setup errors, failed assertions, timeout, cancellation, browser/app crash and unknown outcome after dispatched input |

The Playwright adapter implements only the supported behavior and options. Match its locator defaults and assertion semantics. An unsupported call fails by name. Do not modify existing assertions to count a test as compatible.

### Native and cross-platform scope

| Area | Included in Release 1 |
| --- | --- |
| iOS lifecycle | Install a compatible simulator build, launch, activate and terminate; document app-data and keychain reset behavior |
| macOS lifecycle | Launch a test-owned app, activate and terminate it in an interactive Mac session; document persistent-data isolation |
| Native locators | Accessibility identifier, role, label, text and scoped descendants, with explicit platform mappings |
| Native input | iOS tap, fill, keyboard, scroll/swipe; macOS click, fill, keyboard and scroll in one selected app window |
| Native assertions | Visible/hidden, enabled, text, value, selected state and count where the platform exposes them |
| Native interruptions | Basic app dialogs/alerts needed by the fixture, keyboard visibility, crash detection and useful permission/setup errors |
| Cross-platform flow | Acquire the requested apps before acting; pass ordinary data between them; retry state observations while awaiting sync; report one overall outcome |
| Isolation | Fresh web contexts, documented native reset policy, device/desktop leases and cleanup on failure or stop |
| Native diagnostics | Declared owned-app log sources and app-instrumented HTTP metadata, exercised in the original fixtures; unavailable source status for other apps |

A native macOS app is required. An Electron browser window does not meet that requirement. iOS means simulator support in these two releases; physical iPhone support stays outside the release promise.

The required reference flow creates a uniquely named task in the iOS app, finds and changes that task on the web, and checks its changed state in the macOS app. Run it with Chrome, Firefox and WebKit. A deliberately broken sync must fail at the intended check and leave evidence from the relevant apps.

### TypeScript and installation scope

- Publish JavaScript and declarations that work when installed outside the source checkout.
- Preserve typed app names, targets, secrets, fixtures already supported by Retest, and platform capabilities. Wrong names and unsupported platform methods produce useful compiler errors.
- Support TypeScript/JavaScript ESM tests and configuration, imported helpers, extensionless relative imports, source maps and basic `tsconfig` path aliases.
- Provide a tested transformation path for everyday TypeScript syntax such as enums and parameter properties. It can use a declared compiler/transformer; it does not require writing a compiler.
- Keep TypeScript 6 and 7 checks. Test older compiler versions before publishing a broader minimum-version claim.
- Provide a quick start, explicit pinned browser installation, `doctor`, target prerequisites and actionable setup failures.

Required host checks are macOS arm64 for all five targets and Linux x64 for Chrome/Chromium web tests. Release 2 adds Firefox and WebKit to the advertised Linux web matrix. Existing architecture checks remain useful, but platform claims follow exercised combinations.

### AI evaluation and diagnostic output

Follow the [AI evaluation contract](ai-evaluation.md). Release 1 ships a model-agnostic check over explicit requirements and bounded text, screenshot or recorded-frame evidence. Callers configure named evaluators and credential sources. An optional Vercel AI SDK adapter provides tested initial OpenAI/Anthropic paths without making AI packages or credentials necessary for ordinary tests. Required checks affect the verdict; advisory checks produce warnings. Inconclusive results, provider errors and missing required checks cannot make a required evaluation pass. Keep deterministic checks and earlier failures intact.

Follow the [console/network contract](diagnostics.md). Passing and failing output includes capture status and artifacts for page console/runtime errors and network metadata across all three browsers. The first native network source requires app instrumentation and is verified in the original iOS/macOS fixtures. A native app providing no source reports unavailable data. Collect bounded sanitized records, preserve request correlation and distinguish HTTP error responses from transport failures. Network mocking/wait APIs and unrestricted payload capture do not move into this release.

Rehearsal supplies its evaluator on the authorized host and carries approved criteria through test versions and independent verification. It uploads diagnostic artifacts through the existing evidence path. Selected vision models are Rehearsal configuration; quality claims need measured labelled-case results.

### Reproduction and replay

Follow the [replay contract](replay.md). Retest records distinct sessions, predeclared independently authenticated web participants, bounded owner/host session reservations, declared state preparation, actual executed source/helper/configuration fingerprints, frozen requirement/check identity and attempt-bound evidence. Reproduction against a seeded defect remains an ordinary failed test with a nonzero exit status. The same test runs after an application repair. Caller-specific bug confirmation, test authoring and fix claims stay outside the engine. General source mutation, application digital twins and learned GUI simulation do not enter this release.

### Evidence and Rehearsal scope

Each failed test has its source location, target identity, expected/actual values, action/check timeline and a screenshot when capture is available. The report names missing evidence. JSONL and HTML describe the same outcome, including interrupted and incomplete runs.

The Rust media processor and recording are required in Release 1. Browser and OS APIs capture screenshots and frames. Rust handles frame queues, timestamps, image resizing and thumbnails, video assembly and artifact finalization, using existing codecs for encoding. Screenshot comparison remains a Release 2 extension.

Rehearsal uses this pipeline for live frames and saved recordings through the runner's evidence lifecycle. Finalized artifacts must be ready before the worker uploads and discards them. Local callers may disable recording explicitly; the release must still ship and verify the processor.

The component must support the capture modes advertised for each target, report dropped frames and encoder errors, and flush under a deadline. A media failure has an explicit evidence status alongside the application outcome. Protect secrets in text and handle pixel capture through a documented policy. Measure CPU, memory and complete-run latency with recording on and off before making a speed claim.

Rehearsal uses a pinned candidate through its existing runner boundary. Release 1 includes the bounded observe/act session API needed for web discovery, then codification, independent verification and execution. Exercise passing, failing and interrupted web flows. Keep credentials on the authorized host and browser ownership on the runner.

Retest's native SDK works locally in Release 1. Public native testing inside Rehearsal needs native build ingestion, target configuration, a Mac host and product screens; those belong to Release 2. The library release and Rehearsal rollout have separate gates.

### Release 1 acceptance

- All mandatory basic cases pass on each claimed target, including intended failure cases.
- The iOS/web/macOS reference flow works with every web engine and fails correctly when sync breaks.
- Normal passes and expected assertion failures leave playable video and screenshots through the Rust pipeline on every claimed target. Reports link the evidence to the correct app, test and timeline.
- Cancellation, media-process crashes and encoder failures either finalize usable evidence or report it as incomplete, release owned resources and preserve the application outcome.
- Required AI checks behave correctly for pass/fail/inconclusive/error, keep earlier failures intact and meet the named evaluation-corpus gates. Both initial provider paths have real configured checks; offline use needs no AI packages or keys.
- Every browser leaves correctly scoped console/runtime-error and network artifacts in passing, failing and interrupted runs. Native fixture sources work and unavailable customer sources are explicit. Redaction, overflow and collector cleanup checks pass.
- Rehearsal web discovery, verification and execution exercise the pinned engine, Rust pipeline, host AI evaluation and diagnostic evidence end to end.
- The replay contract passes original-fixture gates across the advertised web engines and native broken-sync flow, including fresh preparation, unchanged checks, intended failures, repaired results and incomplete-evidence rejection.
- A clean Mac installation can run the documented examples without access to this checkout. The Linux Chrome path has the same check.
- Supported Playwright starter and simple workflow tests run without rewriting their actions, assertions or setup dependencies.
- Cancellation, target crash, unavailable platform and denied permissions produce the documented outcomes and release owned resources.
- Packed-package type/runtime checks and existing applicable release gates pass on the chosen commit.

Release 1 has no promised overall coverage percentage. Its minimum scope is the complete basic contract above.

## Release 2

Release 2 keeps the first release's APIs and fills the gaps that block ordinary application tests. Every item below is part of the proposed release scope. Implementing it includes its supported options, failures and cleanup.

| Area | Added in Release 2 |
| --- | --- |
| Fixtures and setup | `test.extend`, test/worker fixture lifecycles, beforeAll/afterAll, `test.use`, test metadata, reusable setup and teardown |
| More locators/checks | `filter`, descendant conditions, class/attribute/empty checks and options required by the chosen workflow cases |
| More interaction | Double click, drag/drop and richer keyboard/mouse actions |
| Pages and embedded UI | Popups/tabs, arbitrary additional context creation beyond Release 1 named participants, dialogs, frame locators and open shadow-root lookup |
| Files | Upload/download, completion and errors, cleanup, and evidence links |
| Network and setup data | Request/response waits, API request fixture and basic route mocking; console/errors and network diagnostic output already ship in Release 1 |
| Browser settings | Common permission, locale, timezone, device-emulation and proxy/auth settings, with a tested per-engine matrix |
| Reliability controls | Configured retries with attempt history and flaky status, failure attachments and explicit slow/fixme behavior |
| TypeScript loading | CommonJS suites/configuration, wider monorepo resolution, project references and JSX/TSX helper transformation; extend the tested compiler matrix |
| Native app breadth | Multiple macOS windows, native menus/dialogs, richer gestures, declared permission handling and stronger reset/recovery behavior |
| Reports | JUnit, additional attachments and richer HTML diagnostics |
| Hosts | Tested Firefox/WebKit on Linux, remote Mac execution, native resource leases and executor health reporting |
| Rehearsal native product | Authorized app builds/targets, build ingestion, setup, native execution and evidence in the product before advertising those workflows |

Screenshot comparison is a Release 2 extension if the fixed workflow selection needs it. Start with a bounded browser implementation and reviewable baselines. It is not a promise of image comparison across every native platform.

### Release 2 acceptance

- All Release 1 gates still pass.
- Meet the 80% browser workflow target on Chrome, Firefox and WebKit separately.
- Each promised new feature has a passing ordinary-use case and its required failure/cleanup checks.
- Native and cross-platform cases meet their separate gates; browser coverage cannot hide a broken native app or sync flow.
- Test the common fixture/configuration paths against pinned existing Playwright workflows without rewriting assertions or removing dependencies.
- Run clean-host installation and pilot checks, including recorded failures and lost executor connections.
- Rehearsal's native onboarding and runs work end to end before inviting customers to use that capability.

## The everyday workflow coverage target

Treat 80% as an acceptance target for representative cases by Release 2. It is not a statistic about the global Playwright user population. Measure complete cases with their setup and expected outcomes; counting API names cannot show whether a flow works.

Build a fixed browser set of 100 cases before expanding implementation. Use these 20 workflow families, with five cases per family covering the ordinary path and relevant variations, delays or failures. The cases are planned and have not been built or scored yet.

| Workflow family | First useful support |
| --- | --- |
| 1. Open a page, navigate and reload | Release 1 |
| 2. Password sign-in and sign-out | Release 1 |
| 3. Reuse signed-in state | Release 1 |
| 4. Create an object through a form | Release 1 |
| 5. Edit and delete an object | Release 1 |
| 6. Show validation errors | Release 1 |
| 7. Select options, checkboxes and radios | Release 1 |
| 8. Find items in lists and tables | Release 1 |
| 9. Search, filter and paginate | Release 1 |
| 10. Wait for loading and asynchronous UI state | Release 1 |
| 11. Open a popup or second tab | Release 2 |
| 12. Accept, dismiss and inspect dialogs | Release 2 |
| 13. Upload and download files | Release 2 |
| 14. Work inside an iframe or open shadow root | Release 2 |
| 15. Check or mock an API interaction | Release 2 |
| 16. Set up test data through an API | Release 2 |
| 17. Reuse custom fixtures and hooks | Release 2 |
| 18. Exercise permission, locale or emulation settings | Release 2 |
| 19. Perform richer pointer/keyboard interactions | Release 2 |
| 20. Retry a transient failure and inspect its evidence | Release 2 |

Release 1 must pass the designated basic cases in families 1 to 10 on every browser. It need not pass every planned variation within those families. In Release 2, the ordinary path for every promised feature must work, and at least 80 of the full 100 cases must match the expected behavior on each browser. Remaining gaps must be named and kept in the denominator.

Use pinned public workflow examples and local deterministic fixtures to select concrete cases. Existing candidates are Immich, AFFiNE and Rehearsal flow examples identified in the architecture plan. Preserve upstream revisions and attribution. Avoid constructing all cases from the features Retest already has.

A case counts as covered only when setup, actions, checks, cleanup and required evidence behave as specified. An intended failure counts only if it fails at the intended assertion or operation for the right reason. An unsupported runtime error does not count as a correct failing test. A skipped case, weakened assertion or removed fixture dependency remains uncovered. Compare Playwright behavior for compatibility cases.

Report three browser scores instead of averaging engines together. Maintain a separate native case list for lifecycle, locators, input, state, interruptions and cleanup, and a separate cross-platform list for sync, cancellation and lease loss. Every mandatory native and cross-platform case must pass in both releases. The 80% number describes browser case coverage; it does not replace those platform promises.

## Outside both releases

- Test sharding, distributed browser scheduling and automatic CI balancing.
- Windows, Android, physical iPhones, branded Safari and Electron-specific APIs.
- Playwright UI mode, trace-viewer format compatibility, component testing and code generation.
- Arbitrary third-party Playwright reporter compatibility.
- Automatic visual fallback for failed locators. AI checks are part of Release 1 and remain read-only.
- Full-video/audio evaluation, model voting/training tools, automatic model selection, WebSocket payload capture and transparent native TLS interception are outside the agreed 0.1.0/0.2.0 promises.
- A Chromium fork, a wholesale Rust runner rewrite and blanket Playwright compatibility.

An everyday flow can reveal a missing basic capability. Review those gaps against the fixed case set before adding work. A request for an advanced infrastructure feature does not automatically expand these two releases.

## Implementation order

For 0.1.0, follow the [five-phase implementation handoff](release-0.1.0.md). It covers foundations and platform proofs, the native cross-platform flow, Firefox/WebKit parity, Rust media and evidence, then Rehearsal integration and the release candidate. AI evaluation and console/network capture are implemented and checked within those same five phases.

After Release 1, add Release 2 features in the order that unblocks the most workflow cases. Fixtures, files, popups/frames and network support precede optional image comparison. Complete native hosting and Rehearsal's native product path, then check the per-browser 80% target and all mandatory gates.

Preparing these candidates does not publish them. Keep the existing manual promotion process and an explicit release decision for each version.
