# AI evaluation contract, fake evaluator and AI SDK adapter: record

3 October 2026. Release 0.1.0, Phase 1 item 9 ([release-0.1.0.md](../release-0.1.0.md)), the [AI evaluation contract](../ai-evaluation.md), and "AI evaluation and diagnostic output" in [releases.md](../releases.md).

## Result

A test can ask for an AI check with `test.evaluate`, and a host can require checks with `RunOptions.hostEvaluations`. In both cases the parent process captures the evidence, resolves the judge's credentials, sets the judge up, reserves the call, sends one request with a deadline and no tools, checks the answer and records the verdict. The test file's process never holds a credential, never loads a judge and never decides a verdict. A scripted fake judge in `tests/support/fake-evaluator.ts` proved the lifecycle through the real parent, offline, for the outcomes the table under "What the fake evaluator proved" names. The optional AI SDK adapter was run from the packed package against a local stand-in for the Anthropic and OpenAI APIs, with the pinned SDK installed from the registry into a project outside the checkout; that test skips as unverified when the install fails, so a green file alone does not show it ran, and its log does. No provider was called: the live gate stays unverified until `RETEST_EVALUATION_ANTHROPIC_KEY` and `RETEST_EVALUATION_OPENAI_KEY` are supplied.

Fake runs prove lifecycle and aggregation. They say nothing about how well any model judges.

## How to run it

From the Retest root, with Node 24.12 or later and Google Chrome:

```sh
node --conditions=retest-source --test tests/unit/evaluation-contract.test.ts tests/unit/evaluation-config.test.ts tests/unit/evaluation-runs.test.ts tests/unit/evaluation-ai-sdk.test.ts tests/unit/evaluation-commands.test.ts
node --conditions=retest-source --test tests/integration/evaluation.test.ts
node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts
npm run test:types
```

The second integration file builds and packs Retest and installs the pinned SDK from the registry into a project in the temporary folder, with an npm cache at `$TMPDIR/retest-ai-sdk-npm-cache`; without the network that test reports itself unverified. Set `RETEST_EVALUATION_ANTHROPIC_KEY` and `RETEST_EVALUATION_OPENAI_KEY` to run the live gate. No other variable or file is read for a key.

## Settled names

| What | Name |
| --- | --- |
| Test API | `test.evaluate({ judge?, requirement, evidence, context?, mode?, timeoutMs? })`, resolving to nothing |
| Requirement | a sentence, one criterion with id `requirement`, or criteria by id: `{ saved: '...', titled: '...' }` |
| Evidence | `{ capture: 'screenshot', app? }`, `{ text, label? }`, `{ recording: { step }, app? }` (declared, refused at run time by name) |
| Modes | `required` (default), `advisory` |
| Config block | `evaluation: { judges, defaultJudge?, timeoutMs?, limits? }` |
| Judge | `{ adapter, credentials?, options?, accepts }`; `adapter` is a module path relative to the config, a package specifier resolved from the config's folder, or a function; `accepts` lists `text`, `images`, `frames` |
| Limits | `callsPerTest` 5, `callsPerRun` 100, `concurrentCalls` 2, `maxOutputTokens` 1000, `maxInputBytes` 8000000, `maxImages` 4, `maxImageWidth` 4096, `maxImageHeight` 4096; `timeoutMs` 30000. Bounds, not measured |
| Typed names | `JudgeName`, `DefaultJudgeName`, `JudgeAccepts` in `register.ts`; `EvaluateOptions`, `EvaluateCheck`, `EvidenceFor` in `src/api/evaluate.ts` |
| Host option | `RunOptions.hostEvaluations`, keyed by test id or file as `hostChecks` is; each `{ id, criteria, evidence, judge?, context?, timeoutMs? }`, always required |
| Evaluator contract | `EvaluatorFactory`, `EvaluatorSetup`, `Evaluator`, `EvaluatorIdentity`, `EvaluationRequest`, `JudgedEvidence`, `JudgeAnswer`, `JsonValue` from the package root |
| Adapter subpath | `@rehearsal-labs/retest/evaluation/ai-sdk`, default export a factory; also `createAiSdkEvaluatorWith` (the factory with a package loader of the caller's own), `aiSdkEvaluator`, `requestMessage`, `AiSdkSetupError`, and the types `AiSdkPackageLoader` and `AiSdkPackageName` |
| Child messages | `evaluate` (child to parent), `evaluation-result` (parent to child) |
| Event | `evaluation.finished`, with the record under `evaluation` |
| Result | `TestResult.evaluations`, `run.started.options.hostEvaluations` |
| Failure classes | `evaluation_failed`, `evaluation_inconclusive`, `evaluation_error` |
| Instructions version | `retest-judge-1` (`src/evaluation/instructions.ts`); adapter version `retest-ai-sdk/1` |
| Check ids | `evaluation-1`, `evaluation-2`... per attempt for a test's own checks; the host's own ids for host checks |

## Request and answer

The request (`EvaluationRequest`), frozen, built by the parent:

- `requestId` (`<attempt>:<check>`), `judge`
- `instructions` and `promptVersion`: Retest's fixed rules, written before any evidence exists
- `criteria`: `{ id, requirement }[]`, redacted; `context`, redacted
- `evidence`: `{ id, kind: 'text', text, label? }` (text redacted) or `{ id, kind: 'image', mediaType: 'image/png', data, width, height, app, capturedAt }`; the image bytes are a copy of what was hashed and saved
- `maxOutputTokens`, `timeoutMs`, `signal`

No function and no handle on a page: a judge cannot act.

The answer the parent accepts (`JudgeAnswer`):

- `criteria`: every requested id exactly once, each with `verdict` `pass`, `fail` or `inconclusive` and `citations` drawn only from the supplied evidence ids; a pass or a fail cites at least one
- `justification`: non-empty, at most 2000 characters
- `modelRevision?`, `usage?` (`inputTokens`, `outputTokens`, `totalTokens`), `samplingNotSent?` (each `setting`, one of `temperature`, `topP`, `seed`, `maxOutputTokens`, with the provider's `reason`, at most 500 characters, each setting once)
- no other key: a self-reported `confidence` makes the answer an error

The record (`EvaluationRecord`, in the event and the result): `checkId`, `source`, `mode`, `judge?`, `verdict` (`pass`, `fail`, `inconclusive`, `error`, `cancelled`, `not_run`), `criteria` with verdicts and citations, `context?`, `criteriaSha256` of the criteria and context as sent, `evidence` (`id`, `kind`, `app?`, `sessionId?`, `attemptId`, `capturedAt`, `path?`, `label?`, `sha256`, `bytes`, `width?`, `height?`), `justification?`, `reason?`, `evaluator?` (`provider`, `model`, `modelRevision?`, `evaluatorVersion`, `promptVersion`, `sampling?`, the settings the call sent, `samplingNotSent?`, the ones it did not send as given with the provider's reason, `latencyMs?`, `usage?`), `failure?`, `warning?`, `durationMs`, `location?`. Justification, reasons, criteria, context and labels pass through the run's redactor before the record exists; judge credentials are taught to the redactor when they are read.

## Policy as implemented

Verdict from criteria: any `fail` fails the check; otherwise any `inconclusive` leaves it inconclusive; only all `pass` passes (`aggregateVerdict` in `src/evaluation/answer.ts`).

| Check ends | Required | Advisory |
| --- | --- | --- |
| pass | satisfies the check, counts as an assertion | nothing |
| fail | `evaluation_failed`, test `failed`, exit 1, counts as an assertion | warning |
| inconclusive | `evaluation_inconclusive`, test `inconclusive`, exit 2 | warning |
| error | `evaluation_error`, test `error`, exit 2 | warning |
| cancelled | the run's interruption itself when the run was stopped; otherwise `evaluation_error` "did not finish", ranked as an error behind any failure, so a test that left the check unawaited ends `failed`, led by `not_awaited` | nothing |
| not_run (host only) | after a body failure, nothing added to that failure; after an interruption, the interruption is the test's failure | not used |

`src/evaluation/policy.ts` writes the table; `src/runner/outcome.ts` maps `evaluation_inconclusive` to the `inconclusive` status and counts `evaluation_error` as ours.

How the test's failure is decided (`withEvaluationFailures` in `src/evaluation/run-evaluations.ts`): the test file's process can never soften what the parent recorded, turning a failed check into an error, an undecided result or a pass. The parent waits for every check still in flight, then takes its own records. With no failed check, the reported failure stands, since a process may always fail its own test. With one, three kinds of failure may lead: the parent's check records; any failure in the report the parent saw for itself, one of `BodyReport.observed` (`src/runner/running-test.ts`: a page command's failed answer, a `check_failed` assertion naming a look the parent served, the parent's stop of the test, the process ending); and any failure the process reports that fails the test, such as a failed `expect` on a value or `not_awaited`, since such a claim can only make the test fail. Among them a failure of the application comes first, then an undecided check, then any other, whatever order they happened in; within one rank, what the parent saw comes before what the process only claims. The lead sets the status, the counts and the exit code. A class the process reports that is not a failure, such as `session_lost`, `outcome_unknown`, `unsupported`, `interrupted` or `setup_failed`, is appended to `details.also` and never leads; its claims of an evaluation class are dropped, lead or line, since the parent writes its own. The parent does not check that a failed assertion naming a served look really fails on that look; such a failure can only make the test fail. The body counts as passed only when the records have no failure; page host checks, then host AI checks, run only after a passing body. An interruption that keeps host AI checks from running becomes the test's failure, as `run-host-checks.ts` does for page checks.

Inconclusive also covers missing evidence: a browser that is gone, a screenshot that fails or is not a PNG with a readable header. Error covers no judge, an unknown judge, evidence the judge does not accept, recorded-step evidence, a judge whose credential, adapter or factory fails, a call past a limit, no answer in time, a judge that throws, and an answer that breaks the contract.

## What the fake evaluator proved

All in `tests/unit/evaluation-runs.test.ts` unless named otherwise; each run is a real test file process and the runner's own parent path, with the fake browser.

| Contract item | Test |
| --- | --- |
| Required pass, fail, inconclusive, malformed, thrown error, each with its status and class | "required AI checks through the parent" › "a pass passes the test and counts as its assertion", "each outcome keeps the test from passing with a reason of its own", "the reasons say what happened without quoting the judge as Retest" |
| Exit code per required outcome, run alone: 0, 1, 2, 2 | "the exit code of a run, for each required outcome alone" |
| An error caught in test source still fails the test | "an error the test catches still fails the test, as the parent recorded it"; real Chrome: `tests/integration/evaluation.test.ts` ("caught") |
| The parent decides even when the test process forges a pass | "a test file that sends the parent a forged pass after a failed check" |
| Missing required ids, a fabricated citation, a self-reported confidence are errors | the outcome tests above, plus `tests/unit/evaluation-contract.test.ts` › "a judge's answer" |
| Negation cannot turn uncertainty into success | "uncertainty about one criterion keeps the check undecided, whatever the others say"; `evaluation-contract.test.ts` › "a check verdict from its criteria" |
| An earlier failure survives a later pass | "a later pass clears no earlier failure" |
| No tool executes; the judge gets data and a signal | "the judge receives data and a signal: no function, no page, nothing it can act with"; "a test that only acts and captures" (the page's only command is the test's own goto) |
| Hostile app text travels as evidence | "hostile app text reaches the judge as evidence only, never in its instructions or criteria"; adapter: `tests/unit/evaluation-ai-sdk.test.ts` › "writes app text as a JSON string after the criteria". These prove where the text goes. The fake's verdict is scripted, so nothing here shows that hostile text cannot change a real model's verdict |
| A check's time never extends the test's or the config's | "a check's own time never lengthens what its test has left, nor the config's time" (60000 asked: given at most the test's 1500, and at most the config's 2000) |
| Timeout is an error; a check left running when its test ends is cancelled; its answer, arriving while the run goes on, is never read | "a judge that does not answer in time, and a check the test leaves behind": the test file waits until the fake has the call before its test ends, the fake holds its answer until a reporter sees the check written as `cancelled`, and the next test waits until the fake has answered, so the answer comes after the stop and before `run.finished` by construction, with no timer; the test keeps one `cancelled` record. It was run by hand several times, alone and beside other files, with no log kept. "a run stopped while a judge is answering" (exit 130, the record carries the interruption) |
| An interruption while the parent settles a test keeps its host AI checks from running and fails the test | "a run interrupted while the parent settles a test, before its host AI checks" (a reporter stops the run when the click's navigation is written during settle; the test is not passed, both host checks `not_run`, exit 130) |
| A failed check outranks an undecided one whatever order they end in; the process cannot reclassify a check or soften the outcome, and a failure it reports may lead only an undecided or broken check | "two checks at once, the undecided one answering before the failed one" (exit 1); "test processes that report their own failure after the parent recorded a failed check": an evaluation error, a `session_lost` and a `check_failed` the process forged after a failed check, in one run: each test `failed` with `evaluation_failed`, the forged class in `also`, counts 3 failed and 0 error, exit 1, every card led by "AI check failed"; "a failed value expect after an undecided required check" (`failed`, led by `check_failed`, exit 1); "a check still running when the test ends" (`failed`, led by `not_awaited`); `evaluation-contract.test.ts` › "the parent adding the AI check failures to a test" |
| Judge credential variables left out of the environment of the run's test file processes and app servers, the browser launched with them hidden, the key redacted from the start | "a judge's credential, with an app server that reads the same variable": the server's log and the test file's own output say the variable is absent, the fake launcher received it in `hiddenVariables`, a page that shows the key before any check runs is redacted, the run folder holds it nowhere |
| `doctor` and `list` withhold the variables too, and doctor's log is redacted | `tests/unit/evaluation-commands.test.ts`: doctor starts a real server that says the variable is absent, prints the key and fails; the log doctor keeps shows `{{visual.apiKey}}` and no file under `.retest` holds the key; the launch and the start name the variable hidden. `collectFiles`, which `list` calls, loads a test file that writes whether it sees the variable: absent. Without a judge both see it, so neither check passes by accident |
| Provider strings and host criteria redacted | "provider strings and host criteria that hold a value" (a model revision that echoes the key, and `run.started.options.hostEvaluations` with a secret in its criteria, context, evidence text and label) |
| An adapter that never loads cannot hold the run | "an adapter whose module never finishes loading" (top-level await that never settles; the checks fail naming the judge and the adapter, `run.finished` is written) |
| A screenshot of the default app takes its lane | "a screenshot check of the default app beside an action on it" (`concurrent_commands`, no judge asked) |
| An attempt leaves nothing listening on the run | "the run's signal after a run with AI checks" (no abort listener left) |
| Budgets reserved atomically across workers, concurrency bounded | "the call budget" › "refuses the call past the test limit before it is sent", "is shared by every file worker: exactly the run limit reaches the judge, one call at a time" (2 workers, 4 requests, 3 sent, 1 refused, never 2 at once); `evaluation-contract.test.ts` › "the call budget" |
| Credentials never in the child's environment, events, results or run folder; provider text redacted | "the judge's credential stays in this process", "a provider's words that echo the credential are redacted before anything is kept, and the run folder holds it nowhere" (every file in the run folder read); real Chrome: `tests/integration/evaluation.test.ts` |
| A missing credential fails only the check that needs it, by name | "a judge whose credential is not set" |
| Advisory checks warn, never change status, and alone do not satisfy the assertion rule | "advisory AI checks" |
| Events, `result.json`, a rebuilt result, human and agent reports and `inspect` show criteria, warnings and evaluator metadata | "each check is one parent event, and result.json, a rebuilt result and the events agree", "the human report shows each check on its card…", "the agent report shows each check under its failure", "inspect shows the check in the timeline, and its JSON holds the record", "advisory AI checks" › "are shown by both reports though every test passed" |
| Host-declared checks run without test code, cannot be satisfied by an advisory override, are not run after a body failure, are refused for bad keys, judges, apps and kinds | "AI checks a host declares" |
| Config validation: unknown keys, undeclared default judge, inline credentials refused unquoted, non-JSON options, missing `accepts` | `tests/unit/evaluation-config.test.ts` |
| Typed judge names, accepted evidence kinds, apps, modes; no judges means a type error | `tests/types/fixtures/evaluation/checks.ts`, `tests/types/fixtures/evaluation-none/checks.ts` |
| Real screenshots through a real `retest run`: the saved screenshot's SHA-256 matches the record's, its session and attempt are that attempt's, and the judge's call log names the same kind, app, width, height and byte count; the bytes the judge received are not compared with the file | `tests/integration/evaluation.test.ts` |

## The AI SDK adapter

Inspected and run, downloaded into `~/Library/Caches/retest-evaluation/inspect/` and an npm cache in the temporary folder, never into the repository; no code copied:

| Package | Version | Licence |
| --- | --- | --- |
| `ai` | 7.0.127 | Apache-2.0 |
| `@ai-sdk/anthropic` | 4.0.71 | Apache-2.0 |
| `@ai-sdk/openai` | 4.0.83 | Apache-2.0 |
| `@ai-sdk/provider` (inspected) | 4.0.21 | Apache-2.0 |
| `@ai-sdk/provider-utils` (inspected) | 5.0.53 | Apache-2.0 |

`package.json` declares the three as optional peers: `ai ^7.0.127`, `@ai-sdk/anthropic ^4.0.71`, `@ai-sdk/openai ^4.0.83`, each `optional: true`. Retest still has no dependencies, and installing the packed package installs none of them (`tests/integration/package-smoke.test.ts`).

What the adapter does: an explicit provider instance (`createAnthropic` or `createOpenAI`) with the judge's `apiKey` and an optional `baseURL`; `generateObject` with a strict JSON Schema naming only the request's criterion and evidence ids, `instructions` set to Retest's rules, one user message with the criteria first and evidence after, app text as JSON strings, screenshots as PNG image parts, `maxRetries: 0`, the request's signal, no `tools`; Anthropic's `structuredOutputMode: 'outputFormat'` and OpenAI's `strictJsonSchema: true` (the OpenAI flag is set in the code and asserted by no test). `generateObject` is deprecated in ai 7 in favour of `generateText` with `output`; it was kept because it is the call the pinned versions document for structured objects, and the record names the version. The adapter checks the object with the same reader the parent uses, then returns it with the response's model id and the token counts.

Proved:

- Its own logic against an injected `generateObject`: `tests/unit/evaluation-ai-sdk.test.ts`.
- Setup refuses unknown options, a provider it cannot make, a missing model or key, and fails by name when `ai` is not installed: same file, and through the parent with the adapter named by its package in a project without the SDK.
- From the packed package in a project outside the checkout, without the SDK: a judged check fails its setup naming `ai`, and ordinary tests run (`tests/integration/evaluation-ai-sdk.test.ts`, first test).
- From the packed package with the pinned SDK installed, against a local stand-in for each API, through `retest run` and real Chrome, for each provider: a text check passed, a screenshot check sent a PNG and failed as scripted, a server error was an evaluation error and only one request for it reached the stand-in, so nothing was retried, no request carried tools, every request asked for a JSON schema, Retest's instructions were in the system channel (Anthropic's `system`, OpenAI's instructions or system and developer items) and in no user message, no evidence text reached that channel, the request used the judge's key, the record named the stand-in's model and token counts, and no key reached the run folder or the terminal (second test). This test installs the SDK from the registry and skips as unverified when it cannot, so it proves this only on a run whose log shows it ran.

Intended models for the live gate, untested: Anthropic `claude-sonnet-5`, OpenAI `gpt-5.5-2026-04-23`. The live test in `tests/integration/evaluation-ai-sdk.test.ts` runs one text and one screenshot check against each when both variables are set, and otherwise reports itself skipped as "unverified: RETEST_EVALUATION_ANTHROPIC_KEY and RETEST_EVALUATION_OPENAI_KEY not set, so no provider was called".

## Protocol changes

`schemaVersion` stays 1. Every change adds: a new event type `evaluation.finished`, an optional `evaluations` on a test result, an optional `run.started.options.hostEvaluations`, three new failure classes, two new child messages, and the `inconclusive` test status, which existed and is now produced.

A version 1 reader refuses every run that has an AI check. Objects in the published schema are closed, so a reader that validates with the version 1 schema it shipped with, Retest's own `readRunFolder` and `inspect` included, rejects the new event type, the new keys and the new failure classes. Only a run with no AI checks and no host AI checks stays readable. This follows the repository's precedent of adding to version 1 as the schema grows. It is not the deliberate versioned protocol change the contract asks for before adding a state; that change has not been made, and an older reader gets a refusal, not a degraded read.

The Azure provider work below adds one more optional key, `samplingNotSent` on the evaluator record. A version 1 reader that validates rejects a run whose record carries it, as above; a record carries it only when a call did not send a setting as given.

## What remains unverified

1. The live provider gate: no Anthropic or OpenAI model has judged anything through Retest. The intended model ids are untested, and so is how either provider treats the structured output request beyond what the stand-in proves.
2. Judgement quality: the frozen corpus of 40 labelled cases and its gates belong to Phase 4. Nothing here measures false passes, false failures or repeat agreement.
3. Frames: recorded-step evidence is declared and refused by name; there are no recordings yet.
4. Regions, crops and pixel masking: a screenshot is sent as the page shows it, secrets on screen included. The contract's separate pixel policy is not built.
5. Native targets and Firefox or WebKit captures: only Chromium screenshots were judged.
6. Rehearsal's host evaluator callback, attempt fencing across restarts and AI activity tracking are Phase 5.
7. Prompt-injection resistance of real models: the fixtures prove that hostile text travels as evidence; they cannot prove a verdict cannot change.
8. A credential function is called once per run; a key that rotates during a run is not read again.
9. A real browser's environment: the launch names the judge variables hidden and `chromium-process.ts` spawns without them, but no test here read a real Chrome process's environment. The reviewer ran the same spawn path with `/usr/bin/env` as the executable and saw the variable left out.
10. A check stopped in the moment between taking its call slot and sending: the code checks the signal before it reserves a call and before it sends, but no test lands a stop in that gap.
11. What a start command does itself: Retest leaves the variables out of the environment it gives, but a start command that sources the user's shell profile or loads a `.env` file brings them back, and Retest cannot prevent that.
12. A judge whose `adapter` is a function, inside a run: function adapters appear in the config and the `doctor` and `list` tests only; every run names a module.
13. A factory that does not return in time, apart from a module that never loads: the stuck-module test accepts either message.
14. The setup signal aborted when the run ends.
15. A function credential at run level: that it is called once, its timeout, its redaction, and that it never reaches the child or the run folder. The one run with a function credential (`tests/unit/evaluation-ai-sdk.test.ts`, the project without the SDK) asserts none of these.
16. That the text evidence a judge receives has a secret replaced: the record and the events are checked, the judge's own copy is not.
17. `test.evaluate` refusing an unknown key (`src/api/evaluate.ts`): the config and `hostEvaluations` refusals are tested, this one is not.
18. Inconclusive because the browser was gone or the screenshot failed (`src/evaluation/evidence.ts`): only "not a PNG" is run.
19. The "this run has no judges" error (`src/evaluation/judges.ts`, `run-evaluations.ts`).
20. The input limits `maxImages`, `maxImageWidth`, `maxImageHeight` and `maxInputBytes`: read in `evidence.ts`, reached by no test.
21. A check cut off because its test ran out of time while the check was in flight: the check's own timeout and a test that ends are run, that case is not.
22. "A check stopped before it is sent spends no call" (`attempt.ts`): the stop before the slot is taken is not landed by any test, as item 10 says.
23. `evaluation-1`, `evaluation-2` numbering starting again in a second attempt.
24. The value of `criteriaSha256`: only its shape, 64 hex digits, is checked.
25. Redaction of the identity's `provider` and `model`: only `modelRevision` is checked.
26. A host check cancelled while in flight.
27. The same host check id given both under the file key and under a test key (`run-evaluations.ts`).
28. The adapter's OpenAI `strictJsonSchema: true` is asserted by the unit tests' exact `deepEqual` of the provider options. The pinned OpenAI package sends `strict: true` by default, so the stand-in's check that each schema is strict passes with or without the setting and cannot catch its removal.
29. That the adapter ignores the SDK's own environment variables is proved against the real packages for `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_BASE_URL`, in the Azure section below. A variable a later package version reads is not covered.

## The Azure provider

3 October 2026. The AI SDK adapter gains `provider: 'azure'`, so the live gate can run against an Azure AI Foundry deployment, where Rehearsal keeps its models.

### What was added

- `src/evaluation/ai-sdk.ts`. `provider: 'azure'` makes its provider with `createAzure` from `@ai-sdk/azure`. The adapter gives it the judge's `apiKey`, exactly one of `resourceName` and `baseURL`, and `apiVersion` when the judge names one. `model` is the deployment's name, which the provider calls through OpenAI's Responses model. Its provider options are `{ azure: { strictJsonSchema: true, store: false } }`. The request is the OpenAI path's: one `generateObject` call, `maxRetries: 0`, no tools, the request's signal and output bound.
- Setup refuses, by name and before loading any package: both or neither of `resourceName` and `baseURL`; a `resourceName` that is not one DNS label, as the provider itself requires; an `apiVersion` with anything but letters, digits, dots and hyphens; `resourceName` or `apiVersion` on another provider; a missing model or key. A missing `@ai-sdk/azure` fails the setup by name, as a missing `ai` does.
- `createAiSdkEvaluatorWith(setup, load)` is a new export of the subpath: the factory with a package loader of the caller's own. The default export passes `import`. The unit tests use it, and the guide names it as the loader hook for a host that bundles the SDK.
- A change to the other two providers, found while reading the SDK. Given no `baseURL`, `@ai-sdk/anthropic` 4.0.71 reads `ANTHROPIC_BASE_URL` and `@ai-sdk/openai` 4.0.83 reads `OPENAI_BASE_URL`, then sends the key wherever that names. The guide already said the adapter uses no variable of the SDK's own; that was false for the endpoint. The adapter now gives both an endpoint when the judge names none: `https://api.anthropic.com/v1` or `https://api.openai.com/v1`, the packages' own defaults. A project that relied on those variables to move the judge now names `baseURL`.
- Retest asks OpenAI and Azure not to keep the request. Their Responses API stores a request unless it is sent `store: false`, and the request holds the evidence, a screenshot of the app included. The adapter now sends `store: false` in the provider options, `{ openai: { strictJsonSchema: true, store: false } }` and `{ azure: { strictJsonSchema: true, store: false } }`, which the pinned OpenAI Responses model writes into the request body as `store`. Anthropic's API has no such setting, so nothing is sent for it and nothing is claimed about what Anthropic keeps.
- `package.json`: `@ai-sdk/azure` `^4.0.90` as an optional peer, beside the other three.

### The pin

`@ai-sdk/azure` 4.0.90 was published with `ai` 7.0.127 and depends on exactly the pinned `@ai-sdk/openai` 4.0.83, `@ai-sdk/provider` 4.0.21 and `@ai-sdk/provider-utils` 5.0.53, so the four packages share one copy of each. 4.0.87 and 4.0.89 have the same dependencies; 4.0.86 and earlier depend on older OpenAI and provider releases. Found with `npm view @ai-sdk/azure versions --json`, `npm view @ai-sdk/azure dist-tags --json` and `npm view @ai-sdk/azure@<version> dependencies`, with nothing installed into the repository.

Inspected, downloaded into `~/Library/Caches/retest-evaluation/inspect/` and an npm cache in the temporary folder, never into the repository; no code copied:

| Package | Version | Licence |
| --- | --- | --- |
| `@ai-sdk/azure` | 4.0.90 | Apache-2.0 |
| `@ai-sdk/deepseek`, a dependency of `@ai-sdk/azure` that the adapter never calls | 3.0.58 | Apache-2.0 |

### The SDK's own variables

The built `@ai-sdk/azure` 4.0.90 reads two variables. `AZURE_API_KEY` is read through `loadApiKey` when the provider has no `apiKey`. `AZURE_RESOURCE_NAME` is read through `loadSetting` when it has neither `resourceName` nor `baseURL`. Both helpers in `@ai-sdk/provider-utils` 5.0.53 return a given string without looking at the environment. OpenAI's model classes, which the Azure provider reuses, read none. The adapter always gives the key and one of the two endpoint settings, so neither variable is read.

### What the tests prove

- Unit, `tests/unit/evaluation-ai-sdk.test.ts`, "the adapter's factory for Azure", against stand-ins for `ai` and the provider packages handed to `createAiSdkEvaluatorWith`. The factory loads `ai` and `@ai-sdk/azure`. `createAzure` receives exactly `{ apiKey, resourceName }`, or `{ apiKey, baseURL, apiVersion }`, or `{ apiKey, resourceName, apiVersion }`. The provider is asked for the deployment and the call carries that model, `{ azure: { strictJsonSchema: true } }`, `maxRetries` 0, Retest's instructions, and no `tools` or `toolChoice`. The key is in no part of the call. Each refusal above matches its whole message and loads no package. With `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` set to other values in the test's environment, every provider still receives exactly the judge's settings, an endpoint included for OpenAI and Anthropic, and OpenAI's call carries `strictJsonSchema: true` and `store: false`.
- Unit, the same file, "what the adapter asks a provider to keep". Two calls each through an OpenAI, an Azure and an Anthropic judge: every OpenAI and Azure call carries `store: false` under its own provider name, and no Anthropic call carries a `store` setting.
- Unit, the same file, "an Azure judge through the parent". A project's adapter module hands the factory the stand-ins; the credential is `env('RETEST_UNIT_AZURE_KEY')`; the stand-in provider echoes the key in its words and in its model id. `createAzure` received the judge's key, resource and version, not the variables' values. Each record names `azure` and the deployment, and shows the echoed key as `{{azure.apiKey}}`, as does the human report. The key is in no event, `result.json`, report, test output or run folder file.
- Integration, `tests/integration/evaluation-ai-sdk.test.ts`, "through a proxy, Azure, and Anthropic and OpenAI given no baseURL...". The packed package, with the pinned `ai` and all three providers installed from the registry into a project in the temporary folder, runs through `retest run`. Four judges each answer one text check: Azure by `resourceName: 'retest-resource'`; Azure by `baseURL: 'https://retest-endpoint.openai.azure.com/openai'` with `apiVersion: 'preview'`; Anthropic and OpenAI with no `baseURL`. The run reaches the stand-in as its HTTPS proxy (`NODE_OPTIONS=--use-env-proxy`, `HTTPS_PROXY`) and trusts a certificate for `*.openai.azure.com`, `api.anthropic.com` and `api.openai.com` that openssl makes for the run (`NODE_EXTRA_CA_CERTS`). The stand-in ends each tunnel's TLS, so each request arrives as the SDK addressed it. A Node without that flag refuses to start, so no request can leave the machine. The run's environment also holds `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_BASE_URL` with other values.
- That test asserts: exactly four tunnels, to `api.anthropic.com:443`, `api.openai.com:443`, `retest-resource.openai.azure.com:443` and `retest-endpoint.openai.azure.com:443`; one request each; Azure's `POST /openai/v1/responses?api-version=v1` and `?api-version=preview` with the deployment as the body's `model`, `store: false`, and `text.format` of type `json_schema`, strict, named `retest_verdict`, holding Retest's two answer fields; Anthropic's `POST /v1/messages` with no `store`; OpenAI's `POST /v1/responses` with `store: false` and a strict schema; no tools; Retest's instructions in the system channel and in no user message, and no evidence there; each key in its provider's own header (`api-key`, `x-api-key`, `authorization`) and in no other header, the address or the body; no other judge's key and no value of the SDK's variables in any request; each record naming the provider, the model, the stand-in's model and its token counts; no key in any run folder file, stdout or stderr.
- That test catches the fallback it guards against. With the adapter changed to leave out the resource name, the real SDK sent the request to `decoy-resource.openai.azure.com:443`, the value of `AZURE_RESOURCE_NAME`, and the test failed. With the key left out, the request carried the value of `AZURE_API_KEY`, and the test failed. Both requests went to the stand-in. The source was restored and `dist/` rebuilt.
- The existing OpenAI stand-in test now also asserts that each OpenAI request's schema is strict. The pinned OpenAI package sends `strict: true` by default, so that check passes with or without the adapter's `strictJsonSchema: true`; only the unit test's exact `deepEqual` of the provider options catches its removal, as item 28 now says. The same test asserts that each OpenAI request body carries `store: false`, and that no Anthropic request body has a `store` key.
- Those assertions read the real SDK's request. With `store: false` taken out of the adapter, both stand-in tests failed: the OpenAI bodies had no `store`, nor did the Azure ones.

### After the review

Each fix has a test that failed with the fix taken out and passes with it, in `tests/unit/evaluation-ai-sdk.test.ts` unless named otherwise.

- The record says what a call sent. The pinned OpenAI package, which Azure reuses, drops `temperature` and `topP` for a model it takes to be a reasoning model, judging by the model id or the deployment's name. Anthropic drops them for some models, caps `temperature` at 1, and lowers an output bound above the model's own. Each says so in a `{ type: 'unsupported', feature, details }` warning on the `generateObject` result, which the adapter used to discard. It now reads the warnings and names each setting the call was given that a warning names, with the details as the reason, in the answer's `samplingNotSent`. The parent leaves those settings out of the record's `sampling` and keeps them in `samplingNotSent`, redacted. This needed one optional field through four files outside the adapter: `JudgeAnswer` in `src/evaluation/contract.ts`, the answer reader in `src/evaluation/answer.ts` (each setting once, a reason of 1 to 500 characters), the record built in `src/evaluation/attempt.ts`, and `EvaluatorRecord` with its schema in `src/protocol/evaluation.ts`. Tests: "names each setting a provider warning says was not sent as given", "gives a reason when the warning has no details", "the parent refuses an answer that names an unsent setting twice or with no reason", and, through the parent, "records under sampling only what the call sent", where the record reads `{ topP: 0.5, maxOutputTokens: 1000 }` with `temperature` in `samplingNotSent` and the echoed key redacted. Ignoring the warnings failed 3 tests; keeping the dropped setting in `attempt.ts` failed 1; leaving out the answer check failed 1.
- `seed` is refused. All three pinned packages drop a seed with a warning, so it would only ever be written down. "refuses a seed, which none of the pinned providers sends", for each provider; accepting it failed the test.
- `apiVersion` is refused where the SDK sends none: a base URL whose path ends in `/openai/v1`, a Foundry project address (`.services.ai.azure.com` with a path under `/api/projects/`), or a host outside `openai.azure.com`, `services.ai.azure.com` and `cognitiveservices.azure.com`, as `@ai-sdk/azure` 4.0.90 decides. The message says the SDK sends no api-version there. "refuses an apiVersion with an Azure baseURL the SDK sends none to", each shape refused and taken without `apiVersion`, and the version still taken with a resource name or an `.openai.azure.com` or `.cognitiveservices.azure.com` base URL. Accepting every shape failed the test.
- The refusal no longer suggests a dated `apiVersion`. Microsoft's page on the v1 API, updated 5 June 2026, says it "removes the need for dated `api-version` parameters" and that "`api-version` is no longer a required parameter with the v1 GA API", and lists no accepted values. The message now names only the characters taken.
- `baseURL` over plain http is refused unless the host is `localhost`, `127.0.0.0/8` or `::1`, for all three providers. "refuses a plain http baseURL off this machine for every provider, and takes one to this machine"; taking http anywhere failed the test. The Phase 1 refusal of a value that is not an http or https URL keeps its message.
- `AiSdkPackageLoader` takes `AiSdkPackageName`, the union of `ai` and the three provider packages, so a host's loader typed to those names fits. The doc example returns a promise. `tests/types/fixtures/ai-sdk-loader.ts` shows a narrow loader and a loader over a record typecheck, and a loader for only two of the packages is refused (TS2345); with the loader typed to any string, three unexpected errors failed the type tests.
- A missing package is named from Node's `ERR_MODULE_NOT_FOUND` message. A package the provider's package imports, such as `zod` or `@ai-sdk/deepseek` beside `@ai-sdk/azure`, is named as that package; a missing file inside a package says to reinstall it; a message with no name is quoted. "is named from what Node could not find..."; naming the asked package every time failed the test.
- Anthropic and OpenAI with no `baseURL` are proved against the real packages, in the integration test above. With the default endpoints taken out of the adapter, the real packages addressed `decoy-anthropic.example` and `decoy-openai.example`, the values of `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL`; the stand-in refused both at TLS and the test failed.

### The live gate

"live provider gate: one text and one screenshot check against an Azure deployment" runs when `RETEST_EVALUATION_AZURE_KEY`, one of `RETEST_EVALUATION_AZURE_RESOURCE` and `RETEST_EVALUATION_AZURE_BASE_URL`, and `RETEST_EVALUATION_AZURE_DEPLOYMENT` are set. `RETEST_EVALUATION_AZURE_API_VERSION` is optional. With both endpoint variables set it uses the base URL, which the SDK also prefers. It asks one judge about a text and a screenshot, and asserts that both pass, that each record names `azure`, the deployment and the model that answered, and that the key is in no run folder file, stdout or stderr. Otherwise it skips, naming what is missing. Here it skipped with:

```text
unverified: RETEST_EVALUATION_AZURE_KEY; RETEST_EVALUATION_AZURE_RESOURCE or RETEST_EVALUATION_AZURE_BASE_URL; RETEST_EVALUATION_AZURE_DEPLOYMENT not set, so no Azure deployment was called
```

To run it, from the Retest root, with the key typed into the shell for one run and kept out of every file and the shell history:

```sh
read -rs RETEST_EVALUATION_AZURE_KEY && export RETEST_EVALUATION_AZURE_KEY
export RETEST_EVALUATION_AZURE_RESOURCE=<resource name>
export RETEST_EVALUATION_AZURE_DEPLOYMENT=<deployment name>
lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test --test-name-pattern=Azure tests/integration/evaluation-ai-sdk.test.ts
```

`RETEST_EVALUATION_AZURE_BASE_URL` can stand in for the resource name, and `RETEST_EVALUATION_AZURE_API_VERSION` adds a version. The file builds and packs Retest, so it runs under the heavy-gate lock.

### Commands and results

From the Retest root, with Node 24.12.0, Google Chrome and OpenSSL 3.6.5:

| Command | Result |
| --- | --- |
| `node --conditions=retest-source --test tests/unit/evaluation-ai-sdk.test.ts` | 17 passed, 0 failed |
| `npm run test:unit` | 2103 passed, 0 failed |
| `npm run test:types` | 196 expected errors matched 196 markers in 9 projects, on TypeScript 6.0.3 and 7.0.2 |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck` | exit 0. A second run, while another lane's Electron target work was half done, exited 2 with seven errors in `src/cli/doctor/checks.ts` and `src/runner/fingerprint.ts`; a third, once that tree compiled, exit 0 |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts` | 3 passed, 2 skipped as unverified: the Anthropic and OpenAI live gate and the Azure live gate |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration`, first run | 364 passed, 2 skipped as unverified, 3 failed and 25 cancelled, all in the six files that build and pack Retest. Each stopped at `npm run build` on type errors in `src/cli/doctor/checks.ts`, `src/runner/fingerprint.ts` and `src/runner/target-drivers.ts`, from another lane's uncommitted Electron target work in `src/config` |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration`, second run | 384 passed, 0 failed, 2 skipped as unverified, 17 cancelled, exit 1. `consumer-loading` and `evaluation-ai-sdk` passed, the Azure stand-in test among them. `m2-package`, `m3-host-run`, `m3-package` and `package-smoke` stopped at `npm run build` on type errors in `src/native/webdriver-client.ts`, a third lane's file in progress |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/package-smoke.test.ts`, once the tree compiled | 6 passed, the exact peer list with `@ai-sdk/azure` among them |
| `node --conditions=retest-source --test tests/unit/evaluation-ai-sdk.test.ts`, after `store: false` | 20 passed, 0 failed |
| `npm run test:types`, after `store: false` | 204 expected errors matched 204 markers in 10 projects, on TypeScript 6.0.3 and 7.0.2; the new markers are another lane's |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts`, after `store: false` | 3 passed, 2 skipped as unverified: the two live gates |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`, after `store: false` | exit 0, once a type in the new unit test was narrowed; the run before it exited 2 on that one line |
| `node --conditions=retest-source --test tests/unit/evaluation-ai-sdk.test.ts`, after the review | 28 passed, 0 failed |
| `npm run test:types`, after the review | 208 expected errors matched 208 markers in 10 projects, on TypeScript 6.0.3 and 7.0.2, the new loader fixture among them |
| `lockf -t 0 /tmp/retest-heavy-gate.lock npm run typecheck`, after the review | exit 0 |
| `lockf -t 0 /tmp/retest-heavy-gate.lock node --conditions=retest-source --test tests/integration/evaluation-ai-sdk.test.ts`, after the review | 3 passed, 2 skipped as unverified: the two live gates |
| `npm run test:unit`, after the review, since four shared evaluation files changed | 2229 passed, 0 failed |

Four changes to the adapter were each run against the unit file, and each failed it: no endpoint given to the provider, Azure's options under `openai`, both endpoint settings accepted, no default endpoint for OpenAI and Anthropic. The two changes described above failed the Azure integration test. Taking `store: false` out of the OpenAI path, and out of the Azure path, each failed the unit file.

### What remains unverified

1. The live Azure run. No Azure deployment has judged anything through Retest: no key was supplied, and none of the gate's variables was set here. Whether the deployment accepts a strict JSON schema on the Responses API, a PNG input, the API version given and an output bound of 1000 tokens is unknown until the gate runs.
2. A Foundry project endpoint, `https://<name>.services.ai.azure.com/api/projects/...`, which the SDK addresses differently, and endpoints under `.cognitiveservices.azure.com` or `.services.ai.azure.com`. The stand-in used `.openai.azure.com` addresses only.
3. A `baseURL` that already ends in `/openai/v1`, which the SDK uses as given and without `api-version`, and a gateway that is not an Azure host.
4. A screenshot through the Azure path against the stand-in. Its checks were text; the live gate sends a screenshot.
5. What OpenAI or Azure keep after `store: false`. The stand-ins show the setting reaches the request body; nothing here can see what a provider retains.
6. On a check that ends in an error, the SDK returns no warnings, so that record's `sampling` is what the evaluator was given, not what the call sent.
7. Which settings a real provider drops for a given model. The warnings were stood in for; the rules come from reading the pinned packages.
8. Deployment-based addresses, Microsoft Entra tokens and the chat completions route. The adapter offers none of them.
9. The Anthropic and OpenAI default endpoints against the providers themselves. The proxy test shows the requests are addressed to `api.anthropic.com` and `api.openai.com`; the stand-in answered them.
