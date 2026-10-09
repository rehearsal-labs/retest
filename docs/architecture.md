# Independent Retest architecture

Design proposal, 29 September 2026. The user has chosen a separate project and an independent implementation. Details below are recommendations for the next implementation, not capabilities already present.

Updated 30 September 2026: a later design extends sections 7 and 8 with one test spanning several named apps, judged checks and dataset evals. The [guide](guide.md) says which of these are built: named apps and AI checks through `test.evaluate` are, and dataset evals are not.

This supersedes the earlier recommendation to host Retest inside Playwright Test. Familiar syntax remains useful, but Retest owns the execution semantics and its browser API. Do not claim Playwright compatibility until specific compatibility has been implemented and tested.

## 1. What independence means

Retest will implement its own test registration, fixture lifecycle, scheduling, assertions, browser communication, agent interface and reports. It will not require another test framework or an automation library to perform those jobs.

There are still platform prerequisites. A JavaScript library needs an execution runtime, browser testing needs a browser, and native control needs operating-system interfaces and tooling. The proposed first implementation uses Node.js and Chromium. It does not include a new JavaScript engine, browser engine or operating system.

Bun is a useful reference for integrated design and taking responsibility for performance. Bun itself uses JavaScriptCore and other libraries. Its documentation also identifies work derived from other projects. Owning the product architecture is compatible with using platform foundations. [Bun's licensing and credits](https://bun.sh/docs/project/license).

The initial goal is zero third-party runtime npm dependencies. Type checking and release compilation are separate development-tool choices. TypeScript is a sensible compiler dependency when implementation begins; that would not make Vitest or Playwright responsible for Retest's execution. No dependency has been installed in this project.

## 2. Learn from Vitest without becoming Vitest

Study its configuration, fixture ergonomics, file selection, reporter interfaces, cancellation and error output. Keep recognizable `test`, `expect`, `test.step` and fixture concepts where they help authors and agents. Retest needs a defined contract for each API; familiar spelling does not imply identical semantics.

Do not reproduce Vitest's Vite integration, module mocking, coverage machinery or component ecosystem in the first release. Retest's first job is checking running applications. Module mocking and watch-mode dependency graphs would create a second, much larger project.

Playwright remains a reference for locator semantics and diagnostics. Maestro and Detox are references for native lifecycles and synchronization. Public implementations can inform research, but any copied implementation introduces license and maintenance obligations. The default is original code based on standards and measured behavior.

Sources: [Vitest advanced architecture](https://vitest.dev/guide/advanced/), [Playwright actionability](https://playwright.dev/docs/actionability), [Detox synchronization](https://wix.github.io/Detox/docs/articles/how-detox-works/).

## 3. Initial technology choices

| Area | Proposed choice | Reason |
| --- | --- | --- |
| Implementation | TypeScript, strict types, ESM | Familiar to test authors and agents; describes the public contract directly |
| Initial execution host | Node.js 24.12 or later compatible versions | Built-in process, networking, WebSocket and lightweight TypeScript facilities; the local machine currently has 24.12.0 |
| Production test lifecycle | Retest's own runner | We control scheduling, fixtures, events, cancellation and outcomes |
| First automation backend | Original Chromium CDP client | A bounded browser target without a Playwright or Puppeteer dependency |
| Browser installation | Explicit installed binary path first | Avoid hidden downloads and browser-distribution infrastructure before the client works |
| Source of truth for reports | Versioned events plus referenced artifacts | CLI, agent and future hosted UI read the same results |
| Local agent interface | Finite CLI and JSONL events first | Works with an ordinary coding agent without a hosted account |
| Test format | TypeScript files with erasable syntax initially | Avoid inventing a DSL or transpiler |
| First package | `@rehearsal-labs/retest` | One installation and one version while boundaries are still changing |

Node's native TypeScript support strips types; it does not typecheck, honor TypeScript path aliases or transform all syntax. A published npm package must ship JavaScript and type declarations rather than relying on stripping TypeScript inside `node_modules`. Keep unsupported syntax explicit and fail with a useful message. Full language transformation could be a later optional loader. [Node TypeScript support](https://nodejs.org/api/typescript.html).

A native implementation language is not necessary for the initial runner. Profile first. If encoding frames or processing images dominates, a separate native component can own that measured workload. Writing ordinary scheduling logic in Rust or Zig does not remove model latency or the application's own waiting time.

## 4. Internal modules before a package ecosystem

Proposed future source tree. These directories are intentionally not scaffolded until implementation needs them.

```text
retest/
  src/
    api/          test registration, config and fixture declarations
    runner/       collection, processes, deadlines and fixture cleanup
    assertions/   value matchers and retrying application assertions
    browser/      sessions, locators and browser behavior
      cdp/        Chromium transport and protocol implementation
    protocol/     versioned agent commands, results and events
    reporters/    terminal and JSONL output
    cli/          finite commands and exit statuses
  tests/          independent verification of Retest itself
  fixtures/       small purpose-built apps with known passing/failing states
  examples/       working public examples, once implemented
  docs/
```

Dependencies should point inward. The runner knows a small target-driver contract and emits events. Browser code implements the target behavior. Reporters consume events and do not control execution. The hosted Rehearsal product consumes Retest; Retest never imports Rehearsal product code.

The first package can expose subpaths when they exist, such as `/browser` and `/protocol`. Split into separate packages only when there is an actual separate dependency, release or binary distribution requirement. Likely later candidates are Android/iOS bridges, a visual-controller integration and a Rehearsal service client. Do not build ten empty packages as an ecosystem.

## 5. Owning a runner

The runner needs two explicit phases: collection and execution. Collection loads selected files and registers tests with stable IDs and source locations. Execution runs chosen tests under a declared fixture and isolation policy. Importing a test module executes user code; this is not a security sandbox.

For the first version, use sequential execution in a disposable child process per test file. Each test gets a fresh browser context and test-scoped fixtures. This does not isolate arbitrary module state between tests in one file; document that contract. Parallel execution comes after device/resource leasing and cleanup work.

Tests have separate setup, action, assertion, cleanup and overall deadlines. Fixtures declare dependencies; resolve them in order, detect cycles and tear down successfully created resources in reverse order even when later setup fails. Preserve both the original error and cleanup errors. A broken cleanup must not replace or hide the assertion that failed.

An AbortSignal is cooperative. A timed-out promise can continue running. The parent must revoke the child's ability to issue new driver commands, request cancellation, enforce a bounded grace period and terminate a child that does not stop. The parent owns the browser session lease and releases it after a crash. In-flight remote actions can still have uncertain results.

Assertions retry observations, not actions. A submitted form is not submitted again because its result is late. Every full retry has a fresh attempt ID and fresh isolation. Initial default: no full test retries. A later successful attempt preserves a flaky classification.

Use Node's built-in test/assert tools to verify the first runner independently. In particular, invoke Retest as a subprocess and check its actual exit status, timeout behavior and cleanup. Testing a runner solely through its own pass/fail implementation can conceal a broken failure path.

## 6. Owning browser automation

The first driver will speak CDP directly. The transport needs command IDs, response correlation, session routing, event subscriptions, bounded commands and disconnect handling. The browser layer owns context/page lifecycle, navigation, input, DOM queries and screenshots. [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).

The hard work starts above the transport. Reliable interaction needs strict unique matches, fresh resolution after DOM replacement, visibility and enabled checks, geometry, hit testing, scrolling, input focus and navigation coordination. Do not publish `getByRole` with an approximation that silently ignores accessible-name rules. Begin with a small supported locator set such as explicit test IDs and add role/label behavior against conformance fixtures.

Use real browser input where the test promises a user interaction. Calling an element's JavaScript `click()` is not equivalent to moving and clicking a pointer through an overlay. Record what was attempted and what the browser confirmed.

Cross-origin frames, shadow DOM, dialogs, uploads, downloads, popups and network instrumentation need explicit support contracts. A narrow driver must reject unsupported operations instead of presenting itself as a complete Playwright replacement. Own the browser process used for testing; do not attach to a developer's everyday profile by default.

An action command can be deduplicated within a live executor by command ID. It cannot guarantee exactly-once UI side effects across crashes. Report an unknown outcome if the browser may have acted before the connection died. Inspect before retrying.

## 7. Cross-browser and native expansion

| Target | Proposed route | Constraint |
| --- | --- | --- |
| Chromium | Own CDP implementation | First supported target only after real-browser verification |
| Firefox | Own WebDriver BiDi client | New capability/conformance work; Chromium CDP code does not provide Firefox support |
| Safari | Investigate Apple's supported WebDriver interface | Requires the actual target environment; do not call Chromium emulation Safari testing |
| Android | Own bridge using Android testing/accessibility interfaces | Requires device lifecycle, permissions and instrumentation design |
| iOS | Own bridge using Apple's UI-testing APIs | Requires macOS/Xcode, builds/signing and simulator/device handling |
| Desktop | Start with one explicit app/OS target | Electron and arbitrary native desktop applications are different support commitments |

WebDriver is a protocol family; implementing a protocol does not require the Selenium library. WebDriver BiDi is evolving, so test concrete capabilities and versions rather than assuming parity. Firefox's documentation states that its CDP support ended and that WebDriver BiDi is the remaining Remote Agent protocol. Sources: [W3C BiDi](https://www.w3.org/TR/webdriver-bidi/all/), [Firefox protocol preferences](https://firefox-source-docs.mozilla.org/remote/Prefs.html), [Apple Safari automation](https://developer.apple.com/documentation/webkit/testing-with-webdriver-in-safari).

Android/iOS architecture remains research work. Do not implement both bridges before a browser test is useful. Existing native frameworks are valuable comparison implementations even if they are not dependencies.

## 8. Agent-first behavior

An agent should be able to discover the installed API, observe a session, issue an action, run a file and inspect one failure. Versioned schemas and compact observations matter more than adding a natural-language method around every API.

Ephemeral element refs belong to an observation and session. Saved tests use durable locator recipes. Every event carries a run ID, attempt ID, target ID, sequence and source location where available. Distinguish assertion failure, ambiguous target, unsupported operation, session loss, timeout, cancellation and unknown action outcome.

Record ordered actions, actual assertions and artifacts. A run is green only when all required selected tests complete successfully. No matches, unavailable targets, missing required checks and interrupted runs are not success. Keep the assertion contract outside any automatic repair step that could weaken it.

The VLM integration is optional. Discovery can combine accessibility/DOM observations with screenshots. Visual location during replay is explicit and records the model, observation and resolution. Visual assertions have an inconclusive outcome. No silent switch from a failed structured locator to an AI-chosen control.

Start with CLI/JSONL. Add MCP as a thin adapter to the same versioned operations when a real client needs it. Avoid having separate implementations with different semantics for human, model and cloud callers.

## 9. Open-source and hosted boundaries

The intended public library includes the runner, drivers that are ready, assertions, protocol, local reports and useful documentation. Apache-2.0 is the selected local project license following the proposed open-source direction. Publishing is a separate action and has not occurred.

Rehearsal remains a separate product that can provide managed discovery, independent verification, execution capacity, evidence history and team features. A developer can run Retest locally or in their own CI. A hosted integration sends results through a documented client and API rather than importing product internals.

Do not copy the earlier Playwright-specific example into the new SDK and imply it runs. Rebuild a small example against the independent API as it becomes executable. Preserve the earlier behavioral requirements, including isolation, honest failures and cross-session evidence.

## 10. First implementation milestone

The first milestone is one end-to-end path:

1. A finite CLI selects a test file and collects one test.
2. Retest launches an explicitly configured Chromium in an isolated profile/context.
3. The test opens a local fixture application, fills a field and clicks a control through CDP-backed input.
4. An original Retest assertion verifies the resulting visible state.
5. The runner writes terminal and versioned JSONL results, with a screenshot on failure.
6. A deliberately broken fixture produces a failed assertion and nonzero exit status.
7. A forced timeout or driver disconnect closes owned resources and reports the correct incomplete/failed state.

That proves the architecture without promising a general-purpose browser engine. Then add multiple tests, fixture dependencies and parallel processes. Broader locator behavior and a second browser follow conformance tests. Native and VLM integrations come after a real use case needs them.

Measure cold startup, test collection, command round trips, app waiting, assertion polling, artifact handling and model calls separately. Compare a representative flow with the current Rehearsal implementation, but do not claim a speed advantage before measuring it. Independence trades control over the design for responsibility for bugs and protocol compatibility previously handled by other projects.
