# Reproduction and replay contract for Retest 0.1.0

Updated 3 October 2026. This is required Release 1 work, not a claim about implemented APIs. Follow the [five-phase handoff](release-0.1.0.md) and keep the existing target, dependency and standalone-use boundaries.

Retest must let an authorised host repeat a test from declared starting conditions, identify the exact required check that failed and retain evidence for that attempt. The same test and requirement can then run against a repaired application. Retest reports the actual result of each attempt. Product-specific bug confirmation, authoring, triage and repair claims remain the caller's responsibility.

This contract prepares the engine for autonomous exploration and bug reproduction. A full agent system, automatic source-code mutation, a learned GUI world model and an application digital twin are outside 0.1.0. They are separate product experiments, not prerequisites for releasing the engine.

## Named participants and bounded session ownership

Release 1 supports a bounded set of predeclared named web participants within one flow. Each has an independently owned browser context, its own authentication state and a page. Participants can share an app origin while representing different test accounts. Reuse the existing named-app/session machinery where sufficient rather than adding a parallel context abstraction.

The original reference flow uses two participants: one creates or changes a uniquely identified record, and another reads that exact record. Exercise four independently authenticated sessions as the session-capacity gate. Verify that storage, observations and evidence do not cross identities. This does not promote arbitrary context creation, popups, multiple tabs or a full Playwright fixture system into Release 1.

The caller supplies the trusted session-owner identity and configured limits. Retest enforces per-owner and host-wide active-session reservations, finite queuing, cancellation and resource cleanup through its existing scheduler. Group acquisition for a multi-participant flow must not hold partial capacity forever while waiting for the rest. Use a finite reservation policy and avoid starvation between owners.

Rehearsal's proposed product limits are one orchestrator, up to ten workers and up to four browser sessions per worker. Agent assignment and messaging belong to Rehearsal. The library remains generic and enforces the configured session/resource limits without importing agent types. Forty possible sessions is a maximum derived from those caps, not a default launch count or a proven host capacity. A separately configured shared budget and available resources constrain actual concurrency.

A browser session means an isolated context and page, not necessarily another browser process. Pooling may reuse a process only under the verified isolation policy. Different test accounts are the default in the reference consumer. Deliberately sharing an account does not share browser storage and requires appropriate backend-data coordination. Native work keeps its existing device and interactive-desktop leases; additional web concurrency does not authorise parallel control of one native desktop.

## Isolated sessions and declared state

Discovery and reproduction use different owned sessions. Observation and element references from one session are rejected by another. Saved authentication can be deliberately reused, but mutable browser state and backend data are not silently shared.

The host declares the starting-state policy for each attempt. Fresh browser storage does not imply a fresh application database. Native relaunch does not imply app-data or keychain reset. Record which state is prepared, reused, externally managed or unavailable. Use existing resource reservations and locks to prevent conflicting attempts from modifying the same fixture or native desktop.

Provide a bounded trusted-host preparation and cleanup path. Reuse existing hooks when they satisfy this boundary; add a narrow callback only where necessary. Preparation runs after required resources are acquired and before the first test action. The caller can seed accounts or reset its own fixture service. Retest does not inspect arbitrary databases, infer resets or import application-specific reset logic.

The parent controls deadlines, cancellation, secret resolution and callback results. A failed or uncertain preparation stops the test before issuing app actions and produces a setup outcome. Cleanup is finite and runs after failure or interruption where possible. Keep the original failure and report cleanup failure separately. Giving up on a callback does not prove its dispatched external work was undone.

The prepared-state record includes the fixture or recipe version, seed where relevant, an opaque preparation receipt and sanitized policy metadata. It does not contain account secrets or a database dump. A receipt identifies an operation; it does not prove identical data by itself. The caller supplies an appropriate verification of its required preconditions.

## Identity of the executed test and requirement

Extend the existing versioned events and results rather than creating a second reporting system. The trusted parent records:

- Run, test, target variant, attempt, app and session identities.
- A fingerprint of the actual executed test bundle, including imported helpers, based on a deterministic file manifest.
- The relevant resolved execution configuration and its fingerprint, with secret values omitted and secret references recorded according to the existing policy.
- Host-supplied requirement version and required check identities, including AI criteria and their evaluator policy.
- Actual runtime and browser or native executor identity, plus app build identity when the caller can provide it.
- Starting-state policy and preparation outcome, and the evidence references associated with this attempt.

Fingerprinting source must not write secrets into a report. Do not hash raw credential values as public metadata. Record configuration fields that affect execution, such as target, viewport, timeout policy, fixture recipe and evaluator settings. Make unavailable identity explicit. Reuse existing source, variant and runtime identities where they already satisfy these requirements.

The caller freezes a test version, its required outcomes and relevant execution policy before attempting reproduction. A legitimate edit creates a new version. Generated test code cannot change the parent's requirement, forge preparation success or submit another attempt's evaluation as its own. This is controlled execution metadata, not a cryptographic claim that a customer's entire environment is unchanged.

An application repair intentionally changes the application build. The report preserves both build identities where known; it does not require them to be equal. The test, required behaviour and comparable execution conditions remain fixed. Retest records facts needed by a caller to compare attempts; it does not decide that a bug is fixed.

## Check identity and failure evidence

Each host-required check has a stable identity within the requirement version. Preserve that identity in step/check results, expected and observed values, evaluation verdicts and evidence references. A human-readable label alone is insufficient when the caller needs to compare the same check across runs.

The result distinguishes an intended assertion failure from a setup failure, an unrelated earlier action failure, a crash, cancellation, unknown dispatch outcome and a required check that never ran. Missing or truncated evidence is explicit. Required evidence or judgment that cannot be collected or completed prevents the corresponding required check from passing.

The failing screenshot or recording interval must belong to the reported app, session and attempt. Console and network records carry the same ownership and capture-status rules from the [diagnostic contract](diagnostics.md). AI checks retain the frozen requirement, evidence and evaluator metadata defined by the [evaluation contract](ai-evaluation.md). A later passing attempt never rewrites the original failure or its artifacts.

## Preserved failing tests

A test exposing a real defect still returns a failed assertion and the normal nonzero test exit status. Retest must not turn that application failure into a pass because the caller expected to reproduce a bug. The caller may record successful reproduction separately from the engine verdict.

Keep test source, assertions and host requirements unchanged during reproduction and verification after a fix. If the test is improved, record another test version and repeat its reference checks. Do not quietly relax a requirement, catch an assertion to hide its result or replace the requirement with the observed broken behaviour.

For application behaviour checked by AI, retain explicit disagreement and the configured repeated-evaluation policy. A favourable later judgment does not erase a deterministic failure or an earlier recorded attempt. The caller must not label a single uncertain model response as a verified repair.

## Implementation within the five phases

1. In Phase 1, inventory existing session isolation, host hooks, fingerprints and check identities. Implement the minimal missing trusted-host lifecycle and execution metadata, with independent setup/failure/cancellation checks.
2. In Phase 2, exercise preparation and cleanup on the original iOS, web and macOS fixtures. Document persistent-data limits and preserve the existing cross-platform sync checks.
3. In Phase 3, verify distinct discovery/reproduction sessions, saved authentication, named participant isolation and stable required-check identity on Chrome, Firefox and WebKit. Keep arbitrary multiple-context and fixture APIs in their existing later scope.
4. In Phase 4, carry the execution record and check identity through JSONL, HTML, diagnostics and Rust media artifacts. Validate evidence association under interruption and cleanup failure.
5. In Phase 5, run the standalone replay gates and carry the metadata through Rehearsal's existing supported runner and result path. Full autonomous exploration, finding management and bug-specific authoring remain separate Rehearsal work.

## Release gates

Use original fixture apps, not private customer or sibling product source. The gates must run actual supported targets; mocks verify only lifecycle rules.

- A fixed test passes against a correct fixture, fails at the intended check against a deliberately broken fixture and passes again after that application defect is repaired. Source, requirement and relevant configuration fingerprints remain unchanged. The app-build identity changes deliberately where available.
- On each advertised web engine, repeat the defect in two fresh prepared sessions and repeat the repaired result twice. Reuse the native broken-sync fixture to demonstrate corresponding cross-platform identity and preparation behaviour.
- A two-participant reference flow transfers the exact recorded object between distinct test accounts on every advertised browser. Four named web sessions preserve independent login/storage and enforce owner limits. Multiple owners share the configured host budget without oversubscription; cancellation releases queued and acquired reservations. These gates do not require forty simultaneous sessions.
- A separate session rejects an observation reference from discovery. Fresh input data cannot be substituted by an unrelated object left from a previous attempt.
- Failed, timed-out or uncertain preparation prevents test actions and produces a setup result. Cleanup failure preserves the original application failure and leaves a separately reported problem.
- Changing an imported helper, requirement, evaluator policy or relevant configuration changes the recorded execution identity. A changed check cannot be represented as the original frozen check.
- An early setup/action failure or an unexecuted required check cannot count as reproducing the intended assertion. Missing required capture, inconclusive evaluation and late prior-attempt judgment cannot become success.
- Terminal, JSONL, HTML and host results agree on the application verdict, check identities and evidence status. Failed reproduction tests keep their normal failed verdict and nonzero exit status.
- A standalone consumer exercises preparation and replay without Rehearsal credentials. Rehearsal's supported runner carries the same metadata and evidence through its existing result path without needing a new product exploration API.

Record fixture revisions, actual platform builds, fingerprints, attempts and evidence in the release receipt. These are named conformance gates. They are not a general defect-detection percentage or a promise of deterministic replay for arbitrary applications.
