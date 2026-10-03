# AI evaluation in Retest 0.1.0

3 October 2026. AI evaluation is required functionality in Release 1. The implementation is planned. Follow the [five-phase handoff](release-0.1.0.md) for execution order and the [two-release scope](releases.md) for the rest of the release boundary.

Retest supplies a check that evaluates captured evidence against an explicit requirement. The caller chooses the model, provider and credential source. Rehearsal can supply its own evaluator with selected vision models through the same contract. Ordinary Retest tests require neither AI dependencies nor model credentials.

## What the check is for

Use ordinary assertions for observable facts such as object identity, totals, checked state and exact text. Use AI evaluation where a requirement needs interpretation, such as whether an answer follows a supplied policy, whether a chart conveys the expected trend, or whether a rendered error message explains how to continue.

Every evaluation needs a requirement defined before the judge sees the outcome. "Decide whether this flow succeeded" is too vague on its own. A useful requirement identifies the expected state, relevant region or output, and permitted variation. The model must evaluate those criteria rather than invent an expectation from the app it sees.

An AI check can be a step checkpoint or a declared final outcome check. Multiple checks can evaluate a whole cross-platform journey. A visual check of the final screen cannot prove hidden persistence or synchronization by itself. Retain the exact identity and state checks that establish those facts.

## The Release 1 contract

| Included | Boundary |
| --- | --- |
| Text judgment | Evaluate explicitly supplied text or text captured from an owned app against a requirement and supplied reference context |
| Visual judgment | Evaluate a screenshot of an owned browser, iOS app or macOS app; support a scoped region when the driver can capture it |
| Temporal judgment | Evaluate a bounded, timestamped sequence of frames from a selected recorded step or interval; document sampling gaps |
| Cross-platform evidence | A check may reference evidence from several apps, preserving each app's identity and capture time |
| Named evaluators | Test configuration selects provider/model adapters, credential sources, limits and a default evaluator; individual checks can choose another name |
| Caller-supplied implementation | A typed custom evaluator can use a different SDK, a remote service or a local model without changing the runner |
| Initial convenience adapter | An optional Vercel AI SDK adapter with exercised OpenAI and Anthropic provider paths; exact supported models are selected and pinned during implementation |
| Result policy | Required checks by default; explicitly advisory checks report warnings; pass, fail, inconclusive and infrastructure error remain distinguishable |
| Evidence and reporting | Criterion results, a brief justification, evidence references, model identity, prompt/rubric version, latency and available usage appear in structured records and reports |
| Rehearsal integration | Host-supplied judging of supported web flow requirements through the existing credential and runner boundaries |

All five targets need actual capture-backed visual checks. Browser emulation does not verify native judgment support. Temporal checks operate on frames in 0.1.0 so the evaluator contract does not depend on provider-specific video APIs. Native video input, audio evaluation, model voting, judge-training tools and automatic model selection are beyond this release.

A model must explicitly support the requested input. A text-only model cannot satisfy an image check by silently using extracted text. A missing capture, unreadable region or relevant sampling gap produces an inconclusive result. Sampled frames cannot establish that a very brief event never occurred between samples. Prefer a durable side effect or a deterministic event record when absence or exact timing matters.

## Configuration and test experience

The following is proposed syntax, not an existing export. Implement the API with the repository's typed named-app and configuration conventions. These settings illustrate the required behavior; Phase 1 settles the exact names.

```ts
evaluation: {
  judges: {
    visual: {
      adapter: './evaluation/visual.ts',
      credentials: { apiKey: { env: 'ANTHROPIC_API_KEY' } },
      options: { modelId: '<tested vision model ID>' },
      accepts: ['text', 'images'],
    },
  },
  defaultJudge: 'visual',
  timeoutMs: 30_000,
  limits: {
    callsPerTest: 5,
    callsPerRun: 100,
    concurrentCalls: 2,
    maxOutputTokens: 1_000,
  },
}
```

The numbers are example configuration, not measured defaults. The host loads the adapter module and calls a factory with resolved credentials, validated options and cancellation. Credential sources can be named environment variables or a host callback backed by the caller's secret store. A callback needs a deadline and must never serialize its value into test configuration or events.

```ts
await test.evaluate({
  judge: 'visual',
  requirement: 'The completion message explains that the task was saved.',
  evidence: { app: mac, capture: 'screenshot' },
  mode: 'required',
});
```

The parent captures that app's evidence. Test source does not hand the judge an arbitrary filesystem path. Text input and recorded-step input have their own typed alternatives. An explicitly selected sanitized console/network subset can accompany those inputs; diagnostic records retain their source and evidence IDs. Named judges, app references and supported evidence kinds must typecheck. A per-check timeout can shorten the overall test budget but cannot extend it.

Final checks also need a host declaration path. For Rehearsal, approved flow requirements become immutable check IDs and criteria supplied independently of generated test source. The parent verifies that required checks ran against the correct attempt's evidence. Omission, catching a thrown check error, or an advisory override in generated code cannot satisfy a host-required check. Reuse the existing host-check machinery where its semantics fit; do not make generated code the authority on its own verdict.

## Verdicts and warnings

| Evaluation result | Required check | Advisory check |
| --- | --- | --- |
| Pass | Satisfies this check only | Records a passing observation |
| Fail | Fails the test at this check | Records a warning with the failed criterion |
| Inconclusive | Keeps the test from passing and names insufficient evidence | Records a warning that the requirement could not be judged |
| Provider/configuration error | Keeps the test from passing and names an evaluation/setup error | Records an evaluation warning without inventing an application defect |
| Cancelled | Preserves the run's interruption and leaves this check incomplete | Preserves the same interruption |

Preserve the existing test/run statuses and nonzero exit behavior unless a deliberate versioned protocol change adds another state. The evaluation record carries the detailed reason, so "could not judge" is distinguishable from "the app violated the requirement". A required fail, inconclusive result or error never becomes a passing or skipped test.

For several criteria, pass requires every required criterion to pass. The runner validates criterion IDs, required fields, output bounds and cited evidence IDs. Invalid or missing output is an evaluation error. A short justification cites supplied evidence; it is not a hidden reasoning transcript. Do not use a model's self-reported confidence as an accuracy guarantee or allow negation to turn uncertainty into success.

AI evaluation cannot clear an earlier deterministic assertion failure, unknown action outcome, host-check failure, crash or interruption. A required evaluation counts as an assertion only when it completes with a valid conclusive verdict. Advisory checks alone do not satisfy an assertion requirement. Reports show warnings even when all required checks pass.

## Architecture and dependencies

Use a small internal evaluation module and an evaluator interface. A request holds immutable criterion IDs and requirements, bounded reference context, an evidence manifest, deadline and cancellation. A response holds validated criterion verdicts, evidence citations, a short justification and provider metadata. Credentials and SDK types are absent from the public wire contract.

The parent owns check registration, evidence capture, limits and verdict aggregation. The evaluator adapter owns provider transport and response conversion. The Rust media process owns capture processing and frame extraction. Drivers supply observations; a judge receives read-only evidence and has no app-action tools. Evaluating cannot click, repair selectors or alter a requirement.

Keep Vercel AI SDK and its provider packages optional. A separate export in the initial package can load them only when configured, with accurately declared optional peers and tested packed-package resolution. If dependency packaging requires a separate deployment, record that concrete need before splitting packages. Importing Retest or running ordinary tests must work without those dependencies installed. An AI check with a missing adapter dependency fails setup by name.

The SDK already supplies [structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) and [image input](https://ai-sdk.dev/docs/foundations/prompts). Use explicit provider instances with caller credentials. A Vercel account or gateway is not a Retest prerequisite. The adapter translates the SDK output into Retest's contract and independently validates it. Provider/model capabilities and version differences remain explicit.

Bound input bytes, image dimensions/count, frames, output tokens, calls, concurrency and elapsed time. Reserve call budgets atomically before dispatch across file workers. Surface token usage when available; a price estimate is labelled an estimate with its pricing basis, never a guaranteed invoice limit. Enforceable cost controls in 0.1.0 are request and input/output bounds.

Disable hidden SDK retries and provider fallbacks. The [AI SDK settings](https://ai-sdk.dev/docs/ai-sdk-core/settings) document configurable retries and cancellation. Any explicitly configured transport retry consumes another reservation and appears in the record. Do not rerun a completed fail or inconclusive judgment until a model eventually passes. Perform deterministic readiness waits before freezing evidence. Stop accepting late responses after cancellation; stopping local work cannot prove the provider stopped processing a dispatched request.

Keep source and criteria fixed for a replay. Persist model/provider identity, available model revision, sampling settings, evaluator/prompt version and hashes of approved criteria and sanitized evidence. Exact replay of the same input still does not guarantee the same model judgment. Verdict caching and automatic consensus are not needed for 0.1.0.

## Evidence, secrets and Rehearsal

Evaluate only the evidence explicitly selected for the check. The report links that exact sanitized evidence, its app/session/attempt identity, observation/capture times and any missing frames. A cross-platform manifest is a sequence of captures, not a claim that independent apps were observed simultaneously.

Resolve model credentials on the authorized host. Do not forward them into a generated test process, browser environment, public protocol payload or report. Model requests also receive the existing text redaction and a separate pixel policy. If a selected region cannot safely be sent, use an approved crop/mask or report that evaluation could not run. Provider response text can echo secrets, so redact it before persistence and render it as untrusted text.

App text and pixels are evidence, never instructions. Separate the fixed rubric from app content, give the judge no tools, reject fabricated evidence references, and exercise fixtures containing hostile text that tries to change the verdict. Those controls reduce exposure; they do not make a model immune to misleading input.

In local Retest, the parent resolves credentials and invokes the configured evaluator. In hosted Rehearsal, the worker owns model access and policy. The runner captures evidence and requests evaluation through an authenticated host callback. Keep that callback read-only and bound to the active run, attempt and allowed check IDs. The runner still owns its browsers and reads no product database. Do not place model keys on the runner to simplify the prototype.

For the supported web lifecycle, carry approved evaluation requirements from discovery into saved flow/test versions, codification, independent verification and runs. Preserve workspace access, private discovery evidence, AI activity tracking and restart fencing. Persist the selected evaluator identity with the test version. A restarted attempt cannot accept a late verdict from an earlier attempt. Discovery/generation can propose criteria; neither can silently weaken them after a failure.

Rehearsal's selected models are a product configuration layered over Retest's public interface. The library owns portability, limits and inspectable outcomes. Any claim that Rehearsal judges better requires its own labelled examples and measured error rates.

## Verification before calling it supported

Build a frozen corpus of at least 40 original cases with requirements and human-reviewed labels. Cover text, screenshots and frame sequences, with at least ten cases in each category. Include clear passes, clear failures, incomplete evidence, clipped content, plausible but wrong text, missing transient events and prompt-injection attempts. Keep the full case list and labels independent of model answers. If labels need founder review, complete the fixtures and rubric first, then collect that review.

Run the corpus three times on each advertised default judge configuration. Report false passes, false failures, inconclusive/error rates, repeat agreement, latency and available usage separately. Known critical failures must never pass in this corpus. For unambiguous labelled cases, require at least 90% correct conclusive judgments; an inconclusive result does not count as correct. This is a release gate on the named corpus, not a population accuracy claim. A configuration missing that gate can remain a custom experimental choice, but cannot be the advertised default.

Independently test runner exit status with fake adapters for pass/fail/inconclusive, malformed output, timeout, missing credentials, unavailable model, rate limits, budget exhaustion, cancellation and late replies. Fake adapters verify lifecycle and aggregation, not live model quality. Test that required errors caught in test source still prevent success, missing required IDs fail, no tools execute and earlier failures survive later passes.

Use real browser and native captures for each claimed target, including a controlled visible defect. Exercise temporal checks with a captured notification and with deliberately omitted relevant frames. Check parent ownership and attempt binding. Verify secret handling in sent evidence and persisted output, not just event labels.

Exercise both initial provider paths with real credentials deliberately supplied for evaluation checks. Publish the tested model IDs, SDK/provider versions and supported modes. Offline runs need no keys; live evaluation gates run only when configured and remain unverified if skipped. Do not borrow private sibling credentials. Verify packed consumers with AI dependencies installed and with them absent.

## What the other tools document

These are vendor-documented behaviors, inspected on 2 October 2026, not independent measurements of reliability.

| Tool | Evidence and implication |
| --- | --- |
| Momentic | [AI assertions](https://momentic.ai/docs/core-concepts/writing-assertions) use DOM/accessibility information and viewport screenshots. Its web run assertions sample recorded frames for temporal checks. This supports including both checkpoint and recorded-interval evaluation. |
| QA Wolf | [GenAI testing](https://www.qawolf.com/solutions/gen-ai-testing) describes external model judgment and structured comparisons. Its [run infrastructure](https://www.qawolf.com/run-infra) lists AI assertions and LLM helpers. It already offers this category of check. |
| TestSprite | [UI test generation](https://docs.testsprite.com/web-portal/core/ui/ui-test-gen) documents generated Python/Playwright assertions, recorded evidence and AI failure analysis. These docs do not establish a caller-configurable multimodal judge contract. They do not prove the feature is absent. |
| Bug0 / Passmark | [Passmark](https://bug0.com/p/passmark) documents Claude/Gemini evaluation, arbitration and video assertions. Treat the reliability language as vendor claims. Reuse requires checking its actual license and dependencies; importing its Playwright engine is not the proposed Retest design. |
| BugZero | [bugzeroai.com](https://bugzeroai.com/) exposes only brief positioning in the accessible page. It does not establish an evaluation API. Bug0 is a separate name and should not be assumed to be the product the founder meant. |

AI assertions alone are not a unique feature. The intended Retest distinction combines a familiar TypeScript engine, caller-owned evaluators, one evidence/result contract across browser and native apps, and Rehearsal's separately measured model configuration. Ship the scoped evaluation capability in the existing five phases rather than starting a second evaluation platform.
