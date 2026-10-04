# Retest 0.1.0 scope and implementation plan

Implementation start date 2 October 2026. Scope updated 3 October 2026 to include AI evaluation, console/network diagnostics and the reproduction/replay contract in Release 1. Release 0.1.0 is the first release being built. This document is the handoff for the coding session that implements the complete release in five phases. The scope below records the founder's decisions. Implementation details can change when experiments establish a better route.

The product is a TypeScript testing engine for Chrome/Chromium, Firefox, WebKit, native iOS simulator apps and native macOS apps. One test can move between those apps. Model-agnostic AI checks judge text, screenshots and bounded recorded intervals. Console and network diagnostics accompany the result. A Rust media processor supplies screenshots and recording evidence from the first release. Isolated replay, host-controlled state preparation, execution fingerprints and stable required-check identities preserve reproducible failures and unchanged-test verification after a fix. Rehearsal uses Retest and that media pipeline for its supported web discovery and test lifecycle.

The repository currently keeps `version: 0.0.0` and `private: true` as development metadata. The existing [release process](../../releasing.md) stamps the published artifact with its release version. Build the 0.1.0 candidate without treating the placeholder as a different product version or changing that process accidentally.

## How to use this handoff

Start implementing after reading the repository instructions and checking the current tree. Continue through all five phases. A phase boundary is a verification point, not a request for permission to continue already authorized work. The founder may add requirements during the session; incorporate that steering and update the remaining work.

Use this document for 0.1.0 implementation order and completion. The [two-release scope](releases.md) explains the boundary with Release 2. The [AI evaluation contract](ai-evaluation.md) and [console/network output contract](diagnostics.md) define the new Release 1 requirements. The [reproduction/replay contract](replay.md) specifies state preparation, frozen execution identity and replay gates. The [architecture reference](plan.md), [developer experience design](../developer-experience/design.md), [milestone 3 plan](../milestone-3/build-plan.md) and [speed plan](../speed/plan.md) supply background. Their broader future features do not enlarge 0.1.0.

Read `/Users/dragon/Documents/Projects/Gruvi/Products/retest/AGENTS.md`, `README.md` and `docs/architecture.md`. Before changing Rehearsal integration, read its root and applicable package/app instructions. Preserve existing local changes in both repositories.

## Starting state

At the handoff inspection, Retest HEAD was `73b098b`. `docs/roadmap.md` and `docs/plans/speed/handoff.md` had local changes; `pnpm-lock.yaml` and this planning folder were untracked. Recheck at session start. Retest uses npm and `package-lock.json`; do not delete or commit the other lockfile as incidental cleanup.

Retest already has its own runner, assertions, Chromium CDP client, parent-controlled commands, named web apps, typed registrations, secrets, storage state, file workers, browser pooling, JSONL events, terminal reports and failure screenshots. Reuse those implementations. Firefox, WebKit, native app support, the Rust processor, AI evaluation, console/network capture and much of the planned compatibility are unfinished.

Earlier assessment checks passed TypeScript 6/7 typechecks, 1,639 unit tests and 97 selected real-Chrome integration tests. These are historical results, not a baseline for the next session's changed tree. Rehearsal has an optional Retest execution adapter and a local vendor archive; that is not proof that discovery and the full hosted lifecycle already use the new engine.

## The complete 0.1.0 scope

| Area | Required in 0.1.0 |
| --- | --- |
| Targets | Chrome/Chromium, Firefox and WebKit on macOS arm64; native iOS simulator apps and native macOS apps on that host; Chrome/Chromium web execution on Linux x64 |
| Navigation | Absolute/relative URLs, reload, back/forward, URL/title observations and ordinary navigation waits |
| Locators | Test ID, role/name, label, text, placeholder and CSS for web; scoped lookup, first/last/nth; strict matching and the supported exact/regex options |
| Browser input | Click, hover, fill, keyboard press, select, check/uncheck and scroll with real input and actionability checks |
| Assertions | Visible/hidden, text/contain text, value, count, checked, enabled/disabled, URL/title; negation, supported regex matching, value assertions, soft assertions and polling |
| AI evaluation | Text, screenshots and bounded timestamped frame sequences; named model/provider-agnostic evaluators, optional AI SDK adapter, host credential sources, required/advisory checks, explicit inconclusive/error outcomes and budget limits |
| Test API | Tests, suites, steps, beforeEach/afterEach, parameterized tests, skip/only and forbid-only in CI; bounded test/action/assertion/evaluation timeouts |
| Configuration | Discovery/filtering, target selection, browser projects, base URL, viewport, one app-server command with readiness and cleanup |
| Authentication | Fresh browser contexts, cookies/local storage, reusable signed-in state and host-controlled secrets |
| Web participants | Predeclared named participants with separate authenticated contexts/pages within one flow; two-account reference workflow, four-session isolation gate and configurable owner/host session limits |
| Scheduling | Existing file workers/pooling, explicit worker limit, resource reservations, device/desktop leases and shared-state locks |
| Reproduction and replay | Distinct owned sessions, bounded trusted-host preparation/cleanup, declared starting-state policy, executed-bundle/configuration and requirement identity, stable required-check IDs and attempt-bound evidence |
| Native lifecycle | Install a compatible iOS simulator build; launch/activate/terminate apps; document native app-data/keychain reset limits |
| Native interaction | Accessibility identifier, role, label, text and scoped descendants; iOS tap/fill/keyboard/scroll/swipe; macOS click/fill/keyboard/scroll in one selected app window |
| Native checks | Visible/hidden, enabled, text, value, selected state and count where the platform exposes them; basic app dialogs/alerts, keyboard handling and crash/setup errors |
| Cross-platform tests | Acquire all requested apps before acting, share ordinary test data, wait for asynchronous sync and produce one result across apps |
| TypeScript | Shipped JavaScript/declarations, typed names and capabilities, ESM tests/configuration, imported helpers, extensionless imports, source maps, basic path aliases and a tested transform path for enums/parameter properties |
| Rust media | Frame queues, timestamps, resizing, thumbnails, video assembly, finalization and explicit media failure status; browser/OS capture and existing codecs remain the capture/encoding foundations |
| Evidence | Screenshots, playable recordings, source locations, expected/actual values, action/check timeline, AI criterion verdicts, JSONL and HTML; interrupted/incomplete evidence remains inspectable |
| Diagnostics | Console messages and uncaught errors; correlated request/response metadata, timing, redirects and transport failures on all three browsers; declared native log and instrumented network sources, with explicit capture status and bounded sanitized artifacts |
| Agent sessions | Bounded open/observe/act/state/frame/close operations needed by Rehearsal web discovery; named session ownership, owner/host capacity limits and references scoped to their session/observation |
| Rehearsal | Pinned Retest artifact, web discovery, codification, independent verification and execution through the runner; host-supplied AI judgment and diagnostic artifacts; Rust live frames and saved artifacts through the existing evidence lifecycle |
| Developer setup | Quick start, explicit pinned browser installation, `doctor`, platform prerequisite checks and actionable setup errors |

Native CSS, URLs, browser storage and network methods are not invented to fill a common interface. Expose the capabilities the selected target really supports. The native reset policy must say what is isolated; app relaunch alone does not clear persistent data.

The Playwright adapter covers straightforward tests using the promised subset. Preserve its supported defaults and assertion behavior. Unsupported members fail by name. The release does not require an assertion-free Playwright test or an escape hatch to behave like native Retest; unresolved semantic differences remain explicit compatibility gaps.

Keep TypeScript 6 and 7 consumer checks. Test older compiler versions before extending the published support range. Retest's core remains TypeScript on Node. Rust is the chosen media language.

## Architecture rules

The runner owns collection, execution, deadlines, scheduling, leases, secrets, results and evidence identity. Drivers implement platform commands and return observations. The Rust process receives media work through a bounded protocol and reports artifacts and failures. Reports consume those records. The parent owns read-only diagnostic collection and evaluation requirements. An evaluator adapter receives bounded sanitized evidence and returns validated judgments. Retest never imports Rehearsal product code.

Keep the existing Chromium implementation behind the expanded session contract. Browser capabilities include navigation, contexts and web storage. Native capabilities include installation, app state and gestures. Use typed capabilities rather than browser methods that silently do nothing on native apps.

Follow the repository's dependency policy. Retest owns its runner and automation implementation. Do not add a required framework package just to complete a prototype. Existing browser builds, Apple APIs, native executor components and codecs can be investigated or reused with accurate prerequisites and attribution. A prototype that uses Playwright or Appium is an explicitly identified experiment; it does not settle the release dependency choice. Record the chosen route in Phase 1 and implement it under the applicable instructions. The optional AI SDK adapter is the explicit new provider integration: keep SDK/provider packages optional and ordinary Retest execution usable without them.

Preserve these invariants throughout the refactor:

- An assertion may observe again; an uncertain action is not blindly dispatched again.
- Cancellation prevents new work and reconciles dispatched input. It cannot undo input already sent.
- A connection loss after dispatch can mean unknown outcome. Preserve that outcome and its last evidence.
- Stale session, observation and app/document references are rejected.
- The parent verifies supported locator assertions from its observations and keeps host outcome checks independent of generated test claims.
- Secrets remain host-controlled and absent from test source, reports and agent-visible text. Pixel capture has a separate redaction/capture policy.
- Original failures survive cleanup failures. Owned resources have finite cleanup and process-exit behavior.
- Reproduction preserves the test and required behaviour. Failed preparation prevents app actions; a known-defect test keeps its normal failed verdict. The engine records replay facts, while the caller owns bug confirmation and fix claims.
- Unavailable targets fail setup; no silent browser substitution or framework fallback.
- AI judges cannot clear earlier failures or alter required criteria. Missing evidence, failed evaluation and inconclusive required checks cannot become success.
- Capture status is explicit. An empty console/network artifact does not prove collection worked. Logs, network details and model responses pass through redaction before persistence.

## Evaluation and diagnostics in this release

AI evaluation is optional to enable but required to ship and verify. A check selects a named evaluator, an explicit requirement and evidence from an owned app or recorded interval. Required checks affect the test verdict; advisory checks produce visible warnings. The parent resolves credentials and limits, freezes evidence and rejects malformed or late judgments. Rehearsal supplies its evaluator through the authorized host instead of storing model keys on the browser runner. See the [evaluation contract](ai-evaluation.md), including the proposed API, provider adapter and calibration gates.

Console/network capture is part of passing and failing output. Each browser supplies console messages, runtime errors and request/response lifecycle metadata with bounded, redacted records. Native logs and native HTTP metadata use declared sources; the first native network source requires app instrumentation. Native output must name unavailable capture when a customer app provides none. Reports retain provenance and missing-data status. Observation is read-only; network mocks, wait APIs and body capture do not move into Release 1. See the [diagnostic contract](diagnostics.md).

## Reproduction and replay in this release

Follow the [replay contract](replay.md). Implement distinct sessions, bounded host state preparation, executed source/helper/configuration fingerprints, requirement and required-check identities, and correctly associated evidence. Browser isolation and native relaunch do not imply backend data reset. A deliberately failing reproduction test remains an ordinary failed test; the caller decides whether it reproduced a finding. Preserve failure evidence and support running the same test against a repaired app. Full autonomous exploration, source-code mutation and learned app simulation are separate product work outside this engine release.

## Phase 1 Foundations and executable platform proofs

Goal: establish the 0.1.0 contracts, loader and Chromium baseline, and prove that each remaining target has a viable real execution/capture route.

### Implementation

1. Inventory existing capabilities against the scope table. Mark each as existing/verified, needs changes or missing. Run the current applicable baseline before changing behavior. Check Node 24.12 or later, browser executables, Xcode/simulator tooling and Rust tooling. Do not restart someone else's app processes as setup cleanup.
2. Freeze the required basic workflow cases. Cover navigation, login/logout, saved auth, form creation, editing/deletion, validation, selection controls, lists, search/pagination and delayed UI state. Give each an ordinary passing path and a meaningful failure or variation. Add conformance cases for every promised method and option. These are Release 1 gates, not an 80% claim.
3. Expand the browser-only boundary into a typed session/capability contract. Include bounded commands, observations, action dispatch state, cancellation, resource identity and evidence references. Adapt Chromium first and preserve its parent-owned checks, secret guards and isolation.
4. Complete the missing Release 1 test API, locator composition, actions and assertions on Chromium. Add selection controls, skip/only, configuration mapping and locks. Keep the existing worker/pool behavior unless new measurements establish a reason to change it.
5. Implement the ESM TypeScript loading contract. Evaluate an existing compiler/transformer, declare its role accurately, test helpers/aliases/transformed syntax and preserve source locations. Check runtime loading separately from declaration compatibility. Do not write a compiler.
6. Prove Firefox launch, isolated session, input, observation and screenshot over BiDi. Prove a WebKit automation build and matching client on macOS; branded Safari does not satisfy this target. Inspect the necessary WebKit protocol/build code and its licenses before adapting it. Do not presume Chromium transport code supplies either browser.
7. Drive one real iOS simulator screen and one native macOS window. XCTest-backed WebDriverAgent and Mac2 are relevant executor references. Establish how the chosen approach installs/launches, observes, dispatches input and captures pixels without making another framework the Retest runner.
8. Prove a small Rust frame-to-video path using an existing codec, including encoder failure and clean shutdown. Select the process protocol and binary packaging approach. A minimal working proof is useful; empty future packages are not.
9. Implement the first evaluation request/result contract, typed named judges, host-only credential resolution, evidence ownership and required/advisory policy. Add a fake evaluator to independently prove pass/fail/inconclusive/error exit behavior, including errors caught in test source. Prove real text and screenshot evaluation through the optional AI SDK adapter when deliberately supplied credentials are available. Pin tested SDK/provider versions and model IDs; no hidden gateway, retries or fallback.
10. Define diagnostic events, artifact references, capture scope/status, redaction and limits. Implement Chromium page console/runtime errors and network metadata subscriptions before navigation, correlated through response/completion/failure. Preserve redirect hops and pending requests. Freeze original diagnostic fixtures and the human-reviewable evaluation corpus before tuning judges.

11. Implement the minimal missing replay lifecycle and metadata from the replay contract, including predeclared named web participants, independent account state and configured owner/host session limits. Reuse existing host hooks and identities where sufficient. Add a bounded trusted-host preparation/cleanup path only where needed, record starting-state policy, fingerprint the actual executed bundle and relevant configuration, and protect requirement/check IDs in the parent.

Existing code to start from: [browser contract](../../../src/browser/contract.ts), [API](../../../src/api), [configuration](../../../src/config), [assertions](../../../src/assertions), [protocol](../../../src/protocol), [runner](../../../src/runner), [Playwright adapter](../../../src/playwright) and [CLI](../../../src/cli).

### Verification and phase completion

- Existing Chromium guarantees and the required new basic Chromium cases pass, including failure/timeout/cancellation paths.
- Consumer TypeScript projects load helpers, path aliases and transformed syntax; invalid names/capabilities fail type checks. Build output and declarations work outside this checkout.
- Firefox, WebKit, iOS and macOS proofs act on real targets and produce actual screenshots. A mock transport is only a protocol unit test.
- The Rust proof creates a playable artifact and reports deliberate encoder failure.
- Independent named participants keep login/storage and evidence separate, and configured owner/host limits cannot be bypassed by concurrent session acquisition.
- Host preparation failure or uncertainty prevents test actions, cleanup preserves the original failure, and changed source/helpers/requirements/configuration produce the appropriate identity changes. Independent sessions reject discovery references.
- Parent-controlled evaluation has independently verified failure/uncertainty behavior. Live adapter proofs are distinguished from fake lifecycle checks. Missing credentials leave the live gate unverified.
- Real Chromium fixtures produce console/error and network artifacts, including an HTTP error response distinct from transport failure. Reports name capture scope, truncation and unavailable fields.
- Record selected versions, prerequisites, backend/dependency decisions and remaining gaps. If a route fails, repair or choose a compliant route before treating the target as implemented. Continue useful independent work while addressing a missing external prerequisite.

## Phase 2 Native sessions and the cross-platform flow

Goal: one test creates an object in a native iOS app, changes it in Chrome and verifies it in a native macOS app through Retest's runner.

### Implementation

1. Implement iOS simulator install/launch/activate/terminate and macOS app/window ownership behind the contract from Phase 1. Define clean-state preparation and persistent-data limits. Exercise the host preparation/cleanup path on the original fixtures and record its outcome. Identify the exact app build and platform version in results.
2. Implement native locator mappings, scoped lookup, actionability, input and assertions. Handle the software keyboard and basic app alerts/dialogs required by the fixture. A missing accessibility identifier is a locator failure; do not silently switch to AI coordinates.
3. Implement deterministic acquisition order, bounded reservations, leases, expiry and release. Acquire all the test's requested apps before its first app action. Serialize commands in one session and native work sharing one interactive desktop. Allow web concurrency only under the proven isolation policy.
4. Build small original fixture apps: a native iOS app, a web app and a native macOS app using one local service. Build/run them through documented commands. Keep fixtures and public examples inside Retest; do not copy private Rehearsal product logic.
5. Implement the reference flow. Sign in with seeded test accounts, create a uniquely identified task in iOS, change that exact task on the web, and verify its state on macOS. Include async sync delay and a broken-sync mode. Shared test data must identify the object, rather than match an unrelated visible label.
6. Produce unified events and screenshots with test/app/session/observation identity. Connect native capture adapters to the media input protocol so Phase 4 can complete recording without another session refactor.
7. Exercise screenshot AI checks against iOS/macOS captures and a controlled visible defect. Support multi-app evidence with capture times, retaining deterministic task identity and sync assertions. Implement native owned-app log sources and the typed app-supplied network metadata source in both original fixtures. A customer app without instrumentation gets explicit unavailable network status.
8. Add Electron as a desktop target behind the contract from Phase 1, driven by the Chromium driver over the debugging pipe. Launch the app's own binary with its own user-data folder, treat each window the app opens as a page of the owned app, quit it when the test ends, and record the Electron and Chromium versions in results. The main process, native menus and native dialogs are reached only through what the renderer shows; a capability the driver cannot reach is named unavailable, never faked. Build a small original Electron fixture app on the same local service, and prove a flow that creates a task in Electron and verifies it on the web.

### Verification and phase completion

- The reference flow passes through real iOS, Chrome and macOS apps. Broken sync fails at the intended check.
- Native locators/input/checks have passing and deliberate failure cases. Test stale refs, denied permissions, app crash, lost executor connection and cancellation after dispatch.
- Tests sharing a device, desktop or explicit lock do not overlap unsafely. Partial setup releases already acquired resources.
- A second run starts with the documented isolation policy and does not pass from stale objects or leaked state.
- The test file uses the typed named-app API and requires no hosted account.
- Native visual evaluation uses actual pixels. Native fixture logs and instrumented network records have the correct app/attempt identity; an app without a diagnostic source reports it honestly.
- An Electron fixture app is driven through the same locators, actions and checks as Chrome, with passing and deliberate failure cases; its windows, versions and unavailable capabilities are recorded honestly, and nothing of it is left running after a run.

## Phase 3 Firefox and WebKit parity

Goal: complete the Release 1 browser contract on Firefox and WebKit and run the same cross-platform flow with every web engine.

### Implementation

1. Implement the selected Firefox and WebKit drivers, including session isolation, navigation, locators, real input, assertions, storage state, viewport, capture, console/runtime error observations and network metadata. Share proven semantic code; keep protocol and platform differences explicit.
2. Run the fixed basic browser and method-conformance cases on Chrome, Firefox and WebKit. Preserve defaults, regex/exact behavior, strict matching, actionability and deadlines. Fix driver differences instead of editing assertions to make tests pass.
3. Run the iOS/web/macOS flow once per browser choice, including the broken-sync variation. Record actual engine/build identity.
4. Implement explicit installation/cache inspection for pinned browser builds and checksums, and useful `doctor` diagnostics. Downloads happen only when requested. Keep installed-binary paths usable.
5. Implement or complete the bounded agent session API using the same drivers, observations and command machinery as tests. Include lifecycle, state and frame access required by Rehearsal; keep durable test locators distinct from ephemeral observation refs. Verify distinct discovery/reproduction sessions, saved-auth reuse, two-account object handoff, four-session isolation, owner/host capacity and stable required-check identity on every browser.
6. Expand the Playwright subset enough for the starter and the selected straightforward workflow tests. Map only the supported configuration and methods. Generate the compatibility table from same-case comparisons under pinned Playwright and Retest versions.
7. Run the same console/network fixtures on all browsers and visual evaluation over each browser's real captures. Verify subscriptions across navigation, isolated contexts, pooling and cancellation. Check missing optional protocol fields and collector failures without inventing complete coverage. Exercise both OpenAI and Anthropic adapter paths with the selected models, preserving explicit image capabilities and the same Retest result contract.

### Verification and phase completion

- The promised basic behavior passes on all three engines on macOS arm64. Chrome/Chromium also passes on Linux x64. Preserve existing applicable architecture gates.
- The cross-platform example passes and fails correctly with each engine.
- Every engine produces the required console/error and correlated network records. Passing, failing, interrupted and overflow cases preserve isolation and explicit capture status.
- Real screenshot checks work across browsers with the same requirement/evidence interface. Live judge checks remain separate from deterministic compatibility results.
- Supported unchanged Playwright cases retain their setup, actions and assertions. Intentional failures fail at the intended operation; an unsupported runtime error is not an equivalent failure.
- Agent session operations exercise real targets, reject stale refs and release resources under timeout/stop/disconnect.
- Unsupported target/configuration requests are explicit failures. The support matrix does not claim Firefox/WebKit Linux support, physical iPhones or branded Safari for 0.1.0.

## Phase 4 Rust media and complete evidence

Goal: ship the required Rust media processor and capture/recording pipeline for all five targets before the 0.1.0 candidate is prepared.

### Implementation

1. Implement the Rust component as a separate bounded process initially. Give it a versioned protocol, readiness check, build/version identity, finite commands and controlled shutdown. Keep it independently consumable by the Node library and Rehearsal runner.
2. Feed real browser/OS capture through adapters for Chromium, Firefox, WebKit, iOS and macOS. Keep encoded frames encoded when extra decoding is unnecessary. Measure copies, allocation and IPC before choosing shared memory or an addon. Capture cadence and fallback modes must be recorded accurately.
3. Implement bounded frame queues, timestamps, resizing/thumbnails, video assembly and existing codec integration. Report frame drops, unavailable capture and encoder errors. Recording completion must wait for file/container finalization under a deadline.
4. Associate evidence with run, attempt, test, app, session, required-check identity and action/check timeline. Carry the replay execution record and fingerprints through JSONL, HTML, diagnostics and media artifacts. Keep clock/timestamp mapping explicit. Maintain distinct application outcome and evidence status when media fails.
5. Implement the pixel capture/redaction policy, artifact retention, path ownership and safe reads. Text redaction does not redact screenshots or recordings. Untrusted app text is escaped in HTML and never executed as report markup.
6. Change browser/executor cleanup to flush media before terminating owned processes, with a bounded forced-stop path. The current fast Chrome shutdown assumes there is nothing to save and cannot simply remain the recording shutdown policy.
7. Add the HTML evidence report backed by the existing events/results. Include source locations, expected/actual values, screenshots, video and app timeline. Use portable artifact references inside the run folder. Terminal, JSONL and HTML must agree, including incomplete runs.
8. Package tested media binaries or a documented explicit installation/build path. Record supported OS/architecture and codec prerequisites. Clean-host setup must not accidentally depend on the developer's Cargo cache or a locally installed encoder that the instructions omit.
9. Extract bounded timestamped frame sequences for declared step/interval evaluations. Preserve missing-frame information and never use sampling to claim a fleeting event was absent. Add criterion verdicts, short evidence citations, provider identity/usage and console/network views to the report. Permit explicitly selected sanitized diagnostics as judge context. Implement budget/cancellation races and the fixed corpus checks from the evaluation contract, then record latency, repeat disagreement and false passes.

Existing code to start from: [browser lifecycle](../../../src/browser/browser.ts), [run store](../../../src/store), [reporters](../../../src/reporters), [result protocol](../../../src/protocol/result.ts) and [events](../../../src/protocol/events.ts). New Rust modules and build scripts are created only for this working component.

### Verification and phase completion

- Normal passes and expected assertion failures produce valid screenshots and playable recordings for all five claimed targets. The three cross-platform browser variants have evidence from each app.
- Independently inspect/decode artifacts for duration, frame order and finalization. A file's existence is insufficient.
- Cancellation, encoder failure, media-process crash, capture loss, queue saturation and shutdown either finalize usable evidence or report incomplete evidence. No orphan processes or unbounded queues remain.
- Reports identify dropped/missing media and preserve the observed application outcome. Required evidence gates cannot quietly accept missing artifacts.
- Text, screenshots and recorded-frame evaluations meet the named corpus gates. Provider errors, malformed output, missing frames and exhausted limits keep required checks from passing. Reports preserve criterion results, warnings, diagnostic artifacts and evaluator metadata.
- Diagnostic record floods remain bounded and sanitized; missing data is explicit. AI and HTML consume the same approved evidence references.
- Compare recording on/off for cold and warm runs, including complete-run latency, CPU, memory and artifact size. Match settings when comparing Playwright. Do not run heavy test suites alongside benchmarks, and make no speed claim before reproducible results establish it.

## Phase 5 Rehearsal integration and the release candidate

Goal: Rehearsal's supported web lifecycle uses the pinned 0.1.0 engine and Rust pipeline, and another developer can install and run the release candidate.

### Implementation

1. Pack a candidate from the tested source and replace Rehearsal's older vendor artifact with that exact candidate. Record its source revision, version and digest. Keep library release metadata and vendored candidate metadata consistent with the existing promotion policy.
2. Integrate the session API into Rehearsal's `BrowserRuntime` through `apps/runner`. The worker owns orchestration and credentials; it does not launch browsers. The runner holds sessions/specs/artifacts and does not read the product database.
3. Exercise Re:agent discovery, saved flows, codification, independent verification and ordinary runs on the Retest path. Generated tests use the supported contract. Preserve host proof/outcome checks and runtime identity on results.
4. Carry host-owned inbox/login helpers through an adapter when a selected supported flow requires them. Keep Rehearsal domain logic out of Retest. Tools advertise actual capabilities. Adapt the selected predeclared multi-participant web flow and its test-eligibility checks to the named-session contract. Broader file/tab and dynamic-participant flows outside 0.1.0 do not silently become supported; preserve an explicit engine migration path for existing test versions instead of a hidden fallback.
5. Connect Rust live frames to the existing relay path and saved artifacts to evidence upload. Upload finalized files before discarding sessions. Preserve viewer authorization, private discovery access, secret handling, durable run recovery and stop behavior.
6. Make Retest the engine for the advertised supported web flows. Verify default/routing choices in the code rather than assuming that an optional adapter changes them. Keep each test/run's declared runtime visible and historical test versions executable under their intended engine.
7. Update README, guide, examples, support matrix, prerequisite/install instructions, compatibility table and measured performance notes. Native SDK use is local in 0.1.0; native Rehearsal hosting/onboarding stays in Release 2.
8. Run clean-consumer and release checks, fix failures, and prepare the 0.1.0 release receipt. This phase prepares the package and promotion inputs. Publishing, tagging, pushing and production deployment require their own authorization under the existing instructions.
9. Carry approved AI requirements and evaluator identity through flow/test versions, codification, independent verification and runs. Add the authenticated host evaluation callback so the worker owns credentials and policy while the runner captures evidence. Enforce required check IDs and attempt fencing; generated tests cannot weaken them. Carry console/network artifacts through existing authorized evidence uploads and signed reads. Verify AI activity tracking, secret handling, advisory warnings and inability-to-judge outcomes.

10. Run the standalone original-fixture replay gates: fixed test, correct fixture, seeded defect, fresh reproduction and repaired app. Preserve source/requirement/configuration identity and normal failure exits. Carry replay metadata and evidence through Rehearsal's existing supported runner/result path. Verify the bounded named-participant reference flow through the existing adapter and result path. New product exploration, findings and bug-specific authoring APIs are not prerequisites for these engine gates.

Rehearsal code to inspect first:

- `/Users/dragon/Documents/Projects/Gruvi/Products/rehearsal/packages/retest-adapter`
- `/Users/dragon/Documents/Projects/Gruvi/Products/rehearsal/packages/codegen/src/retest`
- `/Users/dragon/Documents/Projects/Gruvi/Products/rehearsal/packages/browser/src/runtime.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/rehearsal/apps/runner/src/host.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/rehearsal/agents/reagent/src/tools/browser.ts`
- `/Users/dragon/Documents/Projects/Gruvi/Products/rehearsal/agents/codifier`

### Verification and phase completion

- Rehearsal's supported web flow completes discovery, codification, independent verification and execution through Retest with Rust evidence. A deliberately broken flow fails correctly.
- Stop, runner loss and evidence failure preserve the product's failure/recovery rules. No worker browser fallback or credential leak is introduced.
- Rehearsal's passing, failing and interrupted web runs expose console/network evidence and invoke configured AI checks. Required failed/inconclusive checks prevent success; advisory checks remain visible; model keys never reach runner/test processes and late prior-attempt verdicts are rejected.
- Replay gates preserve the same executed test and requirement, identify the intended failing check, reject failed preparation and missing required evidence, and retain original failures after repair. Every browser has two fresh defective attempts and two repaired attempts; native replay uses the original broken-sync fixture.
- A clean macOS consumer runs the browser examples and native cross-platform fixture using the packed artifact. A clean Linux x64 consumer runs the Chrome path and media processor.
- All applicable build, type, independent runner, browser/native, media, evaluation, diagnostics, replay, package and integration checks pass. Tests with unavailable real prerequisites are recorded as unverified; skipping them does not finish the release.
- The release candidate's CLI and manifest report 0.1.0 when stamped for promotion, and its declarations/binaries/assets resolve outside the repository.
- The final receipt identifies the source state, exact artifact/digest, host/tool versions, checks and their outputs, known compatibility gaps and promotion steps. No required gate remains unresolved.

## Verification commands and progress

Use the existing scripts as the baseline from the Retest root, with the supported Node executable on PATH:

```sh
npm run build
npm run typecheck
npm run test:unit
npm run test:types
npm run test:integration
```

Add native/media/evaluation/diagnostic/replay/consumer checks with their implementation and documented prerequisites. Keep fake evaluator lifecycle tests offline; explicitly configured live model checks are separate release gates, with model versions and corpus results recorded. Reuse `docker/linux/run.sh` and `.github/workflows/ci.yml` for applicable Linux/macOS checks, extending their real target gates where needed. The Rehearsal adapter currently has `typecheck`, `lint` and `bun test` scripts; run checks appropriate to the packages changed and the actual end-to-end path.

Keep concise progress notes beside this document with implemented capabilities, remaining work, exact verification commands, artifact locations and unresolved prerequisites. At each phase boundary update the notes and continue. After context compaction, resume from that record instead of restarting or treating unverified work as complete.

| Phase | Initial status | Completion evidence |
| --- | --- | --- |
| 1 Foundations and platform proofs | Not started for this release plan | Chromium baseline, consumer types/loading, real target proofs, evaluation policy/adapter proofs, diagnostic contracts and replay lifecycle/identity |
| 2 Native cross-platform flow | Not started | Passing and broken-sync flows, native behavior/visual checks, native diagnostic sources and resource cleanup |
| 3 Browser parity | Not started | Three-engine conformance/diagnostics/visual evidence, agent sessions and scoped compatibility results |
| 4 Rust media and evidence | Not started | Playable artifacts, frame evaluations, corpus results, diagnostic/report/replay identity consistency and measurements |
| 5 Rehearsal and candidate | Not started | Full web lifecycle with host AI checks, diagnostics and replay evidence, standalone replay gates, clean-consumer checks and candidate receipt |

## Outside 0.1.0

Autonomous exploration coordination, finding triage and bug-specific test authoring are Rehearsal product work. Automatic source-code mutation, general application cloning, digital twins, learned GUI world models and arbitrary deterministic replay are outside the 0.1.0 engine scope. The replay contract supplies execution facts and bounded hooks without committing those research features.

The bounded predeclared web-participant contract is included in 0.1.0. Arbitrary context creation, custom fixtures and suite-level hooks, broader Playwright metadata/configuration, popups/tabs, frames/shadow roots, uploads/downloads, API/network mocks, configured retries, CommonJS/JSX expansion, JUnit, screenshot comparison, multiple native windows/menus and native Rehearsal hosting belong to Release 2. Existing features need not be removed just because they are beyond the promised minimum.

Sharding, distributed CI balancing, Android, Windows, physical iPhones, branded Safari, Electron beyond what the Chromium driver reaches through the renderer (native menus, dialogs, the main process), component testing, Playwright UI/trace-viewer compatibility and a wholesale Rust runner rewrite are outside these two releases. The 80% everyday browser coverage target belongs to Release 2 and does not substitute for the mandatory 0.1.0 gates.

Build all five phases against the fixed scope. The release is complete when the supported workflows, Rust evidence, AI evaluation, console/network diagnostics, reproduction/replay contract, Rehearsal path and clean-install checks work for the stated platforms, with no required result inferred from mocks or skipped tests.
