# AI eval libraries and AI-assisted testing tools

Research for Retest's developer experience, 30 September 2026. Track: how existing tools write, judge, gate, repeat, cache, compare and report AI evaluations, and what Retest must accept to stay compatible with them.

Method and limits:

- Sources are official docs, GitHub source and package registries, fetched on 30 September 2026. The link next to each claim is the page it came from.
- The fetch tool passes pages through a summarising model. Code blocks, type definitions and terminal output were requested character for character. Short prose quotes are as returned; check them again before quoting them in public.
- Each claim below that would change the design was fetched a second time and matched. These are: the promptfoo acquisition, OpenAI Evals shutdown dates, Inspect's interval and reducer metrics, Opik test suites, Phoenix acceptance criteria, the OpenTelemetry evaluation event, Midscene and Momentic caching rules, the autoevals `Score` type, the vitest-evals redesign, the Braintrust summary output and the Pydantic Evals table.
- **UNVERIFIED** marks anything not confirmed on a fetched page. "From source" means rebuilt from string literals in the tool's code, not seen as real output.

## 1. What changes the design

1. **Nobody gates on uncertainty.** Of every eval tool surveyed, only Inspect AI reports confidence intervals (`ci()`, `ci_wilson()`, clustered `stderr()`), and it does not gate on them ([Inspect metrics](https://inspect.aisi.org.uk/metrics.html)). No tool runs a significance test between two runs. Braintrust, LangSmith and Langfuse count improvements and regressions or show averages, and stop there ([Braintrust compare](https://www.braintrust.dev/docs/evaluate/compare-experiments), [LangSmith compare](https://docs.langchain.com/langsmith/compare-experiment-results), [Langfuse compare](https://langfuse.com/docs/evaluation/experiments/compare-experiments)).
2. **No tool has an "inconclusive" outcome, and none checks a judge's evidence.** AI testing tools either pass or throw. The closest relatives are Skyvern's `terminated`, Browser Use's `impossible_task` flag, Momentic's `warn` and Inspect's `NOANSWER` score. None requires a verdict to quote the answer, and none verifies a quote it was given. Anthropic's January 2026 agent-eval guidance recommends giving a model judge "a way out, like providing an instruction to return 'Unknown'" ([Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
3. **Assertions are never cached by the careful tools; two tools can replay an old verdict.**
   - Midscene: "`aiBoolean`, `aiQuery`, `aiAssert` will never be cached" ([Midscene caching](https://midscenejs.com/caching.html)).
   - Momentic lists "AI check and AI extract" under never cached ([Momentic step cache](https://momentic.ai/docs/reliability/step-cache)).
   - Shortest replays a cached passing run and marks it passed without judging again. Stagehand v4 caches `extract()` on Browserbase's servers.
4. **The scorer contract has converged on autoevals' shape.** A scorer is one object argument `{ input, output, expected, ...extra }` returning `{ name, score: number | null, metadata? }` ([autoevals score.ts](https://raw.githubusercontent.com/braintrustdata/autoevals/main/js/score.ts)). Braintrust, evalite 0.x, vitest-evals' legacy API and Langfuse (through an adapter) all take autoevals scorers directly. Return shapes differ in naming (`score` / `value`, `metadata` / `reason` / `comment` / `explanation`), and all of them normalise without loss.
5. **Repeats are converging on "runs per case with a per-case rule".**
   - Inspect: `epochs` with reducers including `pass_at_{k}`, `at_least_{k}` and `pass_k_{k}`.
   - Opik: `runs_per_item` with `pass_threshold`.
   - Phoenix: `repetitions` with a `passRate` acceptance criterion.
   - Pydantic Evals: `repeat=`, averaged per case first.

   promptfoo still pools repeats into one pass rate. Its per-test pass^k is an open PR.
6. **The market moved in 2026.**
   - OpenAI bought promptfoo on 9 March 2026 ([promptfoo blog](https://www.promptfoo.dev/blog/promptfoo-joining-openai/)).
   - OpenAI's hosted Evals platform goes read-only on 31 October 2026 and shuts down on 30 November 2026, with promptfoo as the stated migration path ([OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)).
   - DeepEval shipped a TypeScript package with a Vitest matcher.
   - vitest-evals was rebuilt around "harnesses" and "judges".
   - evalite v1 is still in beta.
   - Magnitude and Shortest look dormant, and Octomind appears discontinued.
7. **Opik's test suites are the closest existing design to Retest's `toMeet`.** They take plain-language assertions judged by a model, runs per item and a per-item pass threshold ([Opik test suites](https://www.comet.com/docs/opik/evaluation/advanced/building-test-suites)). Phoenix's Vitest acceptance criteria are the closest to `test.eval`'s `pass:` block ([Phoenix CI evals](https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/ci-evals)). Both need their vendor's platform; Retest would not.

## 2. Versions and status, 30 September 2026

| Tool | Version | Licence | Language | Status |
| --- | --- | --- | --- | --- |
| promptfoo | 0.123.1, 18 Sep 2026 ([releases](https://github.com/promptfoo/promptfoo/releases)) | MIT | TS/Node | Owned by OpenAI since Mar 2026; "remain open source" |
| DeepEval | 4.2.7 Python ([PyPI](https://pypi.org/project/deepeval/)); npm `deepeval` 0.9.21 ([jsDelivr](https://www.jsdelivr.com/package/npm/deepeval)) | Apache-2.0 (npm licence field UNVERIFIED) | Python, TS | Active; "Jev" judge modes Sep 2026 |
| OpenAI Evals API and graders | n/a; `openai/evals` repo maintenance only ([commits](https://github.com/openai/evals/commits/main)) | MIT (repo) | Hosted | Read-only 31 Oct 2026, shut down 30 Nov 2026 |
| evalite | `latest` 0.19.0, `beta` 1.0.0-beta.16 ([registry](https://registry.npmjs.org/evalite)) | MIT repo, no npm licence field | TS, Vitest | v1 beta since Nov 2025 |
| vitest-evals (Sentry) | 0.17.0, 10 Sep 2026 ([registry](https://registry.npmjs.org/vitest-evals)) | Apache-2.0 | TS, Vitest 4 | Redesigned: harnesses and judges |
| Braintrust SDK | 3.35.0 ([registry](https://registry.npmjs.org/braintrust/latest)) | MIT | TS, Python | CLI renamed `bt` (Apr 2026) |
| autoevals | 0.3.0 ([registry](https://registry.npmjs.org/autoevals/latest)) | MIT | TS, Python | Depends on `openai ^6.7.0` |
| LangSmith JS | 0.10.5 ([registry](https://registry.npmjs.org/langsmith/latest)); openevals 0.2.2 | MIT | TS, Python | Vitest and Jest entry points |
| Inspect AI | 0.3.272, 28 Sep 2026 ([PyPI](https://pypi.org/project/inspect-ai/)) | MIT | Python only | Active |
| Ragas | 0.4.3, Jan 2026 ([PyPI](https://pypi.org/pypi/ragas/json)) | Apache-2.0 | Python only | `evaluate()` deprecated for `@experiment` |
| Opik | 2.2.85, 29 Sep 2026 ([npm](https://registry.npmjs.org/opik/latest)) | Apache-2.0 | Python, TS | Active; test suites |
| Langfuse | Python 4.15.6, `@langfuse/client` 5.11.1 ([npm](https://registry.npmjs.org/@langfuse/client/latest)) | MIT (server except `ee`) | Python, TS | CI gate Action May 2026 |
| Arize Phoenix | `@arizeai/phoenix-client` 7.15.0, `@arizeai/phoenix-evals` 2.6.0 ([npm](https://registry.npmjs.org/@arizeai/phoenix-client/latest)) | Apache-2.0 (TS); Elastic-2.0 (Python server) | Python, TS | Vitest, Jest, pytest CI |
| Pydantic Evals | 2.51.0 ([PyPI](https://pypi.org/pypi/pydantic-evals/json)) | MIT | Python | Active |
| Midscene.js | 1.14.0, 29 Sep 2026 ([releases](https://github.com/web-infra-dev/midscene/releases)) | MIT | TS | Active; beta `@midscene/test` runner |
| Stagehand | 4.1.0 ([registry](https://registry.npmjs.org/@browserbasehq/stagehand/latest)) | MIT | TS | v4 Aug 2026; caching server-side only |
| Magnitude | `magnitude-test` 0.3.13 ([registry](https://registry.npmjs.org/magnitude-test)) | Apache-2.0 | TS | Last commits Feb 2026; docs domain down |
| Shortest | 0.4.9 ([registry](https://registry.npmjs.org/@antiwork/shortest/latest)) | MIT | TS | Last functional commit Aug 2025 |
| Playwright | 1.63.0; `@playwright/mcp` 0.0.83 ([registry](https://registry.npmjs.org/@playwright/test/latest)) | Apache-2.0 | TS | Test Agents since 1.56; no AI assertion |
| Momentic | CLI 3.61.0 ([registry](https://registry.npmjs.org/momentic/latest)) | Commercial | YAML, TS | Active |
| Octomind | n/a | Commercial | n/a | Docs repo archived 14 Jul 2026 ([GitHub](https://github.com/OctoMind-dev/mintlify-docs)); "discontinued in May 2026" per a third party ([Stackpick](https://stackpick.net/tools/octomind/)) |

## 3. Eval frameworks, tool by tool

### 3.1 promptfoo

**Writing an eval.** YAML config, verbatim from [getting-started.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/getting-started.md):

```yaml
prompts:
  - file://prompts.txt
providers:
  - openai:gpt-6-sol
defaultTest:
  assert:
    - type: llm-rubric
      value: Do not mention that you are an AI or chat assistant
    - type: javascript
      # Shorter is better
      value: Math.max(0, Math.min(1, 1 - (output.length - 100) / 900));
tests:
  - vars:
      name: Bob
      question: Can you help me find a specific product on your website?
```

A Node API exists: `promptfoo.evaluate(testSuite, { maxConcurrency })` returns an `Eval` record, and `toEvaluateSummary()` gives the summary ([node-package.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/usage/node-package.md)).

**Assertion types** ([expected-outputs index](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/expected-outputs/index.md)):

- Deterministic text: `equals`, `contains`, `icontains`, `regex`, `starts-with`, `contains-any`, `contains-all`, `icontains-any`, `icontains-all`.
- Deterministic structure: `is-json` and `contains-json` (both take an optional JSON schema), `is-html`, `contains-html`, `is-sql`, `contains-sql`, `is-xml`, `contains-xml`, `is-refusal`.
- Code: `javascript`, `python`, `ruby`, `webhook`.
- Metrics: `rouge-n`, `bleu`, `gleu`, `meteor`, `levenshtein`, `perplexity`, `perplexity-score`, `latency`, `cost`.
- Tools and traces: `is-valid-openai-tools-call`, `tool-call-f1`, `trace-span-count`, `trace-error-spans`, and `trajectory:*`.
- Model-assisted: `similar` (embeddings), `classifier`, `moderation`, `llm-rubric`, `g-eval`, `factuality`, `model-graded-closedqa`, `answer-relevance`, `context-faithfulness`, `context-recall`, `context-relevance`, `select-best`, `max-score`, and `trajectory:goal-success`.

**Modifiers** (same page):

- Any type can be negated with a `not-` prefix.
- Each assertion takes `threshold`, `weight` (default 1.0), `metric` (a named score), `provider`, `rubricPrompt` and `transform`.
- `assert-set` groups assertions, and its `threshold` is the fraction that must pass.
- A test's score is "the weighted average of the scores of all assertions", and a test-level `threshold` fails it below that number ([reference.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/reference.md)).

**Custom scorer signature.** A `javascript` assertion is `(output, context) => boolean | number | GradingResult`. `context` holds `vars`, `prompt`, `test`, `logProbs`, `config`, `provider`, `providerResponse` and `trace` ([javascript assertion](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)). The `GradingResult` core is `{ pass: boolean; score: number; reason: string; namedScores?; componentResults?; tokensUsed?; metadata? }` ([reference.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/reference.md)). The library also exports its graders for reuse: `import { assertions } from 'promptfoo'` gives `matchesSimilarity`, `matchesLlmRubric`, `matchesFactuality` and `matchesClosedQa`. Its Jest/Vitest matcher example builds `toMatchSemanticSimilarity`, `toPassLLMRubric`, `toMatchFactuality` and `toMatchClosedQA` on them ([Jest integration](https://www.promptfoo.dev/docs/integrations/jest/)).

**Judge model** ([model-graded](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/expected-outputs/model-graded/index.md)):

- Precedence: `--grader <provider>` on the command line first, then `defaultTest.options.provider`, then a `provider` on the assertion itself.
- `llm-rubric` asks the grader for `{ reason, score, pass }`. With a `threshold` set, both `pass === true` and `score >= threshold` must hold. If the grader omits `pass`, promptfoo assumes `true` ([llm-rubric](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/expected-outputs/model-graded/llm-rubric.md)). Retest must not copy that default.

**CI gating**, verbatim ([command line](https://www.promptfoo.dev/docs/usage/command-line/)):

> The eval command will return exit code `100` when there is at least 1 test case failure or when the pass rate is below the threshold set by `PROMPTFOO_PASS_RATE_THRESHOLD`.

- `PROMPTFOO_PASS_RATE_THRESHOLD` defaults to 100%.
- `PROMPTFOO_FAILED_TEST_EXIT_CODE` overrides the exit code.
- `-o` writes csv, txt, json, jsonl, yaml, html, xml or **junit.xml**.
- The GitHub Action posts a before-and-after comment on the PR ([github-action.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/integrations/github-action.md)).

**Repeats.**

- `--repeat <n>` runs each test n times. Rows are pooled into one pass rate, with no per-test rule.
- Issue [#5947](https://github.com/promptfoo/promptfoo/issues/5947), open since Oct 2025, asks for pass^N.
- PR [#8108](https://github.com/promptfoo/promptfoo/pull/8108) would add `--pass-power <N>`, computing `(per-test pass rate)^N`. It is still open.
- Issue [#5847](https://github.com/promptfoo/promptfoo/issues/5847) asks for a per-test repeat threshold.

**Datasets** ([test-cases.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/test-cases.md)):

- Formats: CSV, XLSX, JSON, JSONL, YAML, JS/TS/Python generators, Google Sheets and Hugging Face.
- CSV columns are variables, plus reserved columns: `__expected` (an assertion written as `equals: 4`, or plain text), `__expected1..N`, `__description`, `__metric`, `__threshold` and `__metadata:*`.

**Cost and latency.**

- Results carry `latencyMs`, `cost` and `tokenUsage`.
- The `latency` assertion needs `--no-cache`.
- The `cost` assertion needs the provider to report cost ([deterministic.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/expected-outputs/deterministic.md)).

**Caching** ([caching.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/caching.md)):

- On disk at `~/.promptfoo/cache`, with a TTL of 14 days by default.
- Only successful responses are cached.
- Each repeat index has its own namespace, so a repeated run replays the same samples until `--no-cache` is passed.

**Baseline.** `promptfoo view` has "Compare - Diff against another eval (green = added, red = removed)". Filters are "All, Failures, Passes, Errors, Different, Highlights". Cells can show tokens, latency, cost and tokens/sec, and a person can mark a cell passed, failed or give it a custom score ([web-ui.md](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/usage/web-ui.md)).

**Red teaming.**

- `promptfoo redteam setup`, `run` and `report` "automatically scans 50+ vulnerability types" ([quickstart](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/red-team/quickstart.md)).
- Plugins generate adversarial inputs (for example `harmful:hate`, `competitors`, `bola`).
- Strategies deliver them. The defaults are `basic`, `jailbreak:meta` and `jailbreak:composite`, with multi-turn options such as `crescendo` and `goat` ([configuration](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/red-team/configuration.md)).

**Statistics.** None documented. The docs suggest `--repeat` to see variance.

### 3.2 DeepEval (Confident AI)

**Writing an eval**, verbatim apart from shortened strings ([getting started](https://deepeval.com/docs/getting-started)):

```python
from deepeval import assert_test
from deepeval.test_case import LLMTestCase, SingleTurnParams
from deepeval.metrics import GEval

def test_correctness():
    correctness_metric = GEval(
        name="Correctness",
        criteria="Determine if the 'actual output' is correct based on the 'expected output'.",
        evaluation_params=[SingleTurnParams.ACTUAL_OUTPUT, SingleTurnParams.EXPECTED_OUTPUT],
        threshold=0.5
    )
    test_case = LLMTestCase(input="...", actual_output="...", expected_output="...")
    assert_test(test_case, [correctness_metric])
```

The TypeScript package plugs into Vitest ([DeepEval TypeScript](https://deepeval.com/blog/introducing-deepeval-typescript)). Run it with `npx deepeval test run llm_app.test.ts`; "47 of DeepEval's 49 metrics are ported":

```ts
import "deepeval/vitest";
await expect(testCase).toPass([new AnswerRelevancyMetric()]);
```

**Metrics.** G-Eval, DAG, agent metrics (task completion, tool correctness, plan adherence), RAG metrics, multi-turn, safety (bias, toxicity, PII leakage) and JSON correctness ([metrics](https://deepeval.com/docs/metrics-introduction)).

- A metric passes when score ≥ `threshold` (default 0.5, on a 0–1 scale).
- `strict_mode` forces a binary score.
- A metric marked `flaky` never decides its test case.

A custom metric subclasses `BaseMetric` with `measure`, `a_measure` and `is_successful`, and sets `score`, `success` and `reason` ([custom metrics](https://deepeval.com/docs/metrics-custom)).

**Judge model.**

- Set per metric with `model=`.
- Set globally with `deepeval set-openai | set-anthropic | set-ollama | ...`.
- A custom judge subclasses `DeepEvalBaseLLM` ([CLI](https://deepeval.com/docs/command-line-interface)).
- New "Jev" modes (`hybrid`, `system_one`) return "calibrated probabilities" and a `metric.confidence` that "never changes the score" ([eval modes](https://deepeval.com/docs/evaluation-eval-modes)). This is judge decisiveness, not a confidence interval.
- The default judge model name is UNVERIFIED.

**CI and repeats.** `deepeval test run` wraps pytest and exits with pytest's code. Its flags come from [command.py](https://raw.githubusercontent.com/confident-ai/deepeval/main/deepeval/cli/test/command.py):

- `-n` processes.
- `-c` reads cached metric results.
- `-r N` repeats through pytest-repeat. Each repeat is a separate item with no aggregation.
- `-o` marks the official baseline.
- `-x` stops at the first failure.

pass@k exists only inside the HumanEval benchmark ([HumanEval](https://deepeval.com/docs/benchmarks-human-eval)).

**Datasets.** `EvaluationDataset(goldens=[Golden(...)])`, loaded from JSON, CSV or JSONL or pulled from Confident AI ([datasets](https://deepeval.com/docs/evaluation-datasets)). `LLMTestCase` needs `input` and `actual_output`, with optional `expected_output`, `context`, `retrieval_context`, `tools_called`, `expected_tools`, `token_cost` and `completion_time` ([test cases](https://deepeval.com/docs/evaluation-test-cases)).

**Cost.** `metric.evaluation_cost` records judge spend, and a run prints "Total estimated evaluation tokens cost: … USD" ([DataCamp example](https://www.datacamp.com/tutorial/deepeval)).

**Baseline.** On Confident AI, a regression is a test case where a metric that passed in the comparison run now fails. This comes from a search snippet; the page returned 404, so it is UNVERIFIED.

**Statistics.** None.

### 3.3 OpenAI Evals API and graders (shutting down)

- **Status.** "On June 3, 2026, we notified developers using the Evals platform that the product is being deprecated." Evals become read-only on 31 Oct 2026, and "The Evals dashboard and API are scheduled to shut down" on 30 Nov 2026. The recommended path is "Moving from OpenAI Evals to Promptfoo" ([deprecations](https://developers.openai.com/api/docs/deprecations)).
- **Graders.** The graders page says OpenAI is deprecating graders as part of the evals and fine-tuning workflows ([graders](https://developers.openai.com/api/docs/guides/graders)).
- **Grader shapes, useful as a mapping source** ([API reference](https://developers.openai.com/api/reference/resources/graders)):
  - `string_check` takes `{ operation, input, reference }`.
  - `text_similarity` takes `{ evaluation_metric: fuzzy_match | bleu | gleu | meteor | cosine | rouge_* , pass_threshold }`.
  - `score_model` takes `{ model, input: Message[], range, pass_threshold, sampling_params }`.
  - `label_model` takes `{ model, labels, passing_labels }`.
  - `python` is `def grade(sample, item) -> float`.
  - `multi` combines grader keys with a formula.
  - The operation name `ne` versus `neq` differs between the guide and the reference (UNVERIFIED which is correct).
- **Data** is JSONL with one `{ "item": {...} }` per line, templated as `{{ item.field }}` and `{{ sample.output_text }}` ([evals guide](https://developers.openai.com/api/docs/guides/evals)).
- **Gating.** None local. You poll `result_counts { total, errored, failed, passed }`.
- **Guidance.** OpenAI's best-practices page advises "Use pairwise comparison or pass/fail for more reliability", calibrating the judge against human labels before scaling, and "continuous evaluation (CE) to run evals on every change". It has no statistical guidance ([evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)).

Consequence for Retest: teams are migrating off OpenAI's graders this quarter. A published mapping from grader JSON to Retest scorers would help them; OpenAI's own promptfoo guide has no mapping table.

### 3.4 evalite

**Writing an eval**, verbatim ([v1 quickstart](https://v1.evalite.dev/guides/quickstart/)):

```ts
import { evalite } from "evalite";
import { exactMatch } from "evalite/scorers";

evalite("My Eval", {
  data: [{ input: "Hello", expected: "Hello World!" }],
  task: async (input) => {
    return input + " World!";
  },
  scorers: [
    {
      scorer: ({ output, expected }) =>
        exactMatch({ actual: output, expected }),
    },
  ],
});
```

- Files are `*.eval.ts`, "the new `.test.ts`" ([evalite.dev](https://www.evalite.dev/)).
- `evalite.each([...])` compares variants.
- `trialCount` repeats cases.
- `createScorer({ name, description?, scorer: ({ input, output, expected }) => number | { score, metadata? } })` ([createScorer](https://v1.evalite.dev/api/create-scorer/)).
- The 0.x quickstart used autoevals scorers directly (`scorers: [Levenshtein]`) and said "Autoevals is a great library of scorers to get you started" ([0.x scorers](https://www.evalite.dev/guides/scorers)). v1 ships its own `evalite/scorers`, and its model-backed scorers take an AI SDK model per call ([v1 scorers](https://v1.evalite.dev/api/scorers)).

**CI.** "If the average score falls below the threshold, the process exits with code 1." The command is `evalite --threshold=50`, on a 0–100 scale; `--outputPath` exports JSON ([CI/CD](https://v1.evalite.dev/tips/run-evals-on-ci-cd)). The config default `scoreThreshold: 100` would fail any imperfect run, so the effective default is UNVERIFIED ([defineConfig](https://v1.evalite.dev/api/define-config)).

**Repeats.** `trialCount` is "repetitions per test case for variance measurement". The source stores `trialIndex` per row and has no aggregation of its own ([evalite.ts](https://raw.githubusercontent.com/mattpocock/evalite/main/packages/evalite/src/evalite.ts)).

**Caching and cost.** `wrapAISDKModel(model)` caches AI SDK calls by default, keyed on model, parameters and prompt, and records tokens. A cache hit reports 0 tokens. No dollar cost is shown ([AI SDK](https://v1.evalite.dev/api/ai-sdk)).

**Baseline.** The UI score cell shows a green up chevron, a red down chevron or a blue right chevron against the previous run. It does not show the previous number ([score.tsx](https://raw.githubusercontent.com/mattpocock/evalite/main/apps/evalite-ui/app/components/score.tsx)).

**UI.**

- `evalite watch` serves `http://localhost:3006` ([CLI](https://v1.evalite.dev/api/cli/)).
- Default columns are Input, Expected and Output, and a `columns` option customises them ([customise UI](https://v1.evalite.dev/tips/customize-the-ui)).
- `evalite export` writes a static HTML bundle.

**Statistics.** None.

### 3.5 vitest-evals (Sentry)

Now "Harness-backed AI testing on top of Vitest" ([package README](https://raw.githubusercontent.com/getsentry/vitest-evals/main/packages/vitest-evals/README.md)):

```ts
describeEval(
  "refund agent",
  {
    harness: piAiHarness({ agent: () => createRefundAgent() }),
    judgeHarness,
    judges: [FactualityJudge({ expected: "The refund request is approved." })],
    judgeThreshold: 0.6,
  },
  (it) => {
    it("approves a refundable invoice", async ({ run }) => {
      const result = await run("Refund invoice inv_123");
      expect(result.output).toMatchObject({ status: "approved" });
    });
  },
);
```

**Judges.**

- The matcher is `await expect(result).toSatisfyJudge(factualityJudge, { expected, threshold: 0.6 })`.
- Built-in judges are `FactualityJudge`, `StructuredOutputJudge` and `ToolCallJudge`.
- A judge is `{ name, assess(ctx) }` returning `{ score: number | null, metadata?: { rationale? } }` ([judge types](https://raw.githubusercontent.com/getsentry/vitest-evals/main/packages/vitest-evals/src/judges/types.ts)).
- `FactualityJudge` uses the same choice scores as autoevals: A 0.4, B 0.6, C 1, D 0, E 1.

**Legacy API.** The old `describeEval(name, { data, task, scorers, threshold })` lives in `legacy.ts`, marked "Temporary scorer-first compatibility entrypoint" ([legacy.ts](https://raw.githubusercontent.com/getsentry/vitest-evals/main/packages/vitest-evals/src/legacy.ts)). An `autoevals-compatibility.test.ts` still runs Levenshtein, Factuality and ClosedQA through it ([test](https://raw.githubusercontent.com/getsentry/vitest-evals/main/packages/vitest-evals/src/autoevals-compatibility.test.ts)).

**Replay, not caching.**

- `VITEST_EVALS_REPLAY_MODE=off|auto|strict|record` records tool calls to `.vitest-evals/recordings/{toolName}/{sha256}.json` ([replay.ts](https://raw.githubusercontent.com/getsentry/vitest-evals/main/packages/vitest-evals/src/replay.ts)).
- This is the only surveyed tool that records the **tools** an agent calls rather than model responses.

**Reporting**, from source ([reporter.ts](https://raw.githubusercontent.com/getsentry/vitest-evals/main/packages/vitest-evals/src/reporter.ts)):

- Per test: `✓ test name [0.80]`.
- Summary: `app X tok / $X.XX | judge X tok / $X.XX | total X tok / $X.XX | N tools | M err`.
- **Judge cost is split from app cost.**

**CI.** The GitHub Action `getsentry/vitest-evals@v0` takes `min-pass-rate` and `publish-check`, per the root README (not re-fetched, UNVERIFIED). No repeats, baseline or statistics are documented.

### 3.6 Braintrust and autoevals

**Writing an eval**, verbatim ([run in code](https://braintrust.dev/docs/evaluate/run-in-code.md)):

```ts
import { Eval, initDataset } from "braintrust";
import { Factuality } from "autoevals";

Eval("My Project", {
  experimentName: "My experiment",
  data: initDataset("My Project", { dataset: "My dataset" }),
  task: async (input) => {
    // Your LLM call here
    return await callModel(input);
  },
  scores: [Factuality],
  metadata: {
    model: "gpt-5-mini",
  },
});
```

- Run it with `bt eval my_eval.eval.ts`, with `--watch`, `--filter`, `--first N`, `--sample N` and `--jsonl` ([CLI eval](https://www.braintrust.dev/docs/reference/cli/eval)).
- A scorer receives `input, output, expected, metadata, trace` and returns "a number between 0 and 1 (optionally with a `name` and `metadata`)" ([write scorers](https://braintrust.dev/docs/evaluate/write-scorers.md)).
- `trialCount: 10` runs each input 10 times. The UI buckets trials by identical `input` ([advanced](https://braintrust.dev/docs/evaluate/advanced-evaluations.md)).

**No native CI gate.** `bt eval` exits non-zero only when an eval throws. A score gate needs a custom `Reporter` whose `reportRun` returns `false` ([GitHub Actions article, 8 Sep 2026](https://www.braintrust.dev/articles/llm-eval-pipeline-github-actions)).

**Baseline.** "If no baseline is set, Braintrust automatically selects the most recent experiment on the same git branch." The UI shows a score-delta column, with improvements in green and regressions in red ([compare](https://www.braintrust.dev/docs/evaluate/compare-experiments)). The best-practices page advises comparing averages when differences are under 5 points ([best practices](https://www.braintrust.dev/docs/evaluate/best-practices)). There is no interval or test.

**Caching.** Handled by Braintrust's gateway, not the SDK:

- `x-bt-use-cache: auto | always | never`. `auto` caches at `temperature=0` or when a `seed` is set.
- TTL is up to a week ([gateway](https://www.braintrust.dev/docs/deploy/gateway)).

**autoevals scorer type**, verbatim with the doc comments removed ([score.ts](https://raw.githubusercontent.com/braintrustdata/autoevals/main/js/score.ts)):

```ts
export interface Score {
  name: string;
  score: number | null;
  metadata?: Record<string, unknown>;
  error?: unknown; // deprecated
}
export type ScorerArgs<Output, Extra> = {
  output: Output;
  expected?: Output;
} & Extra;
export type Scorer<Output, Extra> = (
  args: ScorerArgs<Output, Extra>,
) => Score | Promise<Score>;
```

**autoevals scorers** ([manifest](https://raw.githubusercontent.com/braintrustdata/autoevals/main/js/manifest.ts), [README](https://raw.githubusercontent.com/braintrustdata/autoevals/main/README.md)):

- Model judges: Battle, ClosedQA, Humor, Factuality, Moderation, Possible, Security, Sql, Summary, Translation.
- RAG: ContextEntityRecall, ContextRelevancy, ContextRecall, ContextPrecision, AnswerRelevancy, AnswerSimilarity, AnswerCorrectness.
- Composite: ListContains, ValidJSON.
- Embeddings: EmbeddingSimilarity.
- Heuristic: JSONDiff, Levenshtein, ExactMatch, NumericDiff.

**autoevals judge setup** ([oai.ts](https://raw.githubusercontent.com/braintrustdata/autoevals/main/js/oai.ts)):

- Global: `init({ client, defaultModel })`.
- Per call: `client` or `model`.
- Environment: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, then Braintrust's gateway.
- Defaults: `gpt-5-mini` for completions and `text-embedding-ada-002` for embeddings.

**`LLMClassifierFromTemplate`** ([llm.ts](https://raw.githubusercontent.com/braintrustdata/autoevals/main/js/llm.ts)):

- The prompt is a mustache template.
- The judge must call a `select_choice` tool, and the score is `choiceScores[choice]`.
- `useCoT` defaults to true.
- The result's `metadata` holds `{ rationale, choice }`.
- Factuality's choice scores are `A 0.4, B 0.6, C 1, D 0, E 1`.

**Who consumes autoevals directly:**

- Braintrust: `scores: [Factuality]`.
- evalite 0.x: `scorers: [Levenshtein]`.
- vitest-evals: the legacy API.
- Langfuse: `createEvaluatorFromAutoevals(Factuality())`, mapped to `{ name, value, comment }` ([Langfuse](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk)).

### 3.7 LangSmith and openevals

**Writing an eval.** `evaluate(target, { data, evaluators, experimentPrefix, maxConcurrency, numRepetitions })`, with `data` a dataset name, an `Example[]` or an `AsyncIterable` ([quickstart](https://docs.langchain.com/langsmith/evaluation-quickstart), [_runner.ts](https://raw.githubusercontent.com/langchain-ai/langsmith-sdk/main/js/src/evaluation/_runner.ts)).

- An evaluator takes any subset of `{ run, example, inputs, outputs, referenceOutputs }` and returns `{ key, score | value, comment? }` ([code evaluators](https://docs.langchain.com/langsmith/code-evaluator-sdk)).
- openevals provides `createLLMAsJudge({ prompt: CORRECTNESS_PROMPT, model: "openai:o3-mini", feedbackKey })` and returns `{ key, score, comment }` ([openevals README](https://raw.githubusercontent.com/langchain-ai/openevals/main/README.md)).

**Vitest/Jest integration**, verbatim ([vitest-jest](https://docs.langchain.com/langsmith/vitest-jest)):

```ts
ls.describe("generate sql demo", () => {
  ls.test(
    "generates select all",
    {
      inputs: { userQuery: "Get all users from the customers table" },
      referenceOutputs: { sql: "SELECT * FROM customers;" },
    },
    async ({ inputs, referenceOutputs }) => {
      const sql = await generateSql(inputs.userQuery);
      ls.logOutputs({ sql }); // <-- Log run outputs, optional
      expect(sql).toEqual(referenceOutputs?.sql); // <-- Assertion result logged under 'pass' feedback key
    }
  );
});
```

**Other helpers.**

- `ls.test.each(DATASET)`, `ls.wrapEvaluator(fn)` and `ls.logFeedback({ key, score })`.
- `await ls.expect(response).evaluatedBy(myEvaluator).toBeGreaterThan(0.5)`, from source JSDoc ([vitest/index.mts](https://raw.githubusercontent.com/langchain-ai/langsmith-sdk/main/js/src/vitest/index.mts)).
- Matchers `toBeRelativeCloseTo` (Levenshtein), `toBeAbsoluteCloseTo` and `toBeSemanticCloseTo` ([matchers.ts](https://raw.githubusercontent.com/langchain-ai/langsmith-sdk/main/js/src/utils/jestlike/matchers.ts)).
- `LANGSMITH_TEST_TRACKING=false` runs locally only.

**Repeats.** "LangSmith displays the average for each feedback score in the table". You can click through "to view the standard deviation across repetitions" ([repetition](https://docs.langchain.com/langsmith/repetition)). This is the only surveyed TypeScript tool that documents a per-case spread.

**Baseline.** Red and green marks against a source experiment, with counts of improved and regressed runs per feedback column ([compare](https://docs.langchain.com/langsmith/compare-experiment-results)). A third-party claim that LangSmith computes p-values is UNVERIFIED and contradicted by other sources.

**Caching.** `LANGSMITH_TEST_CACHE=path` exists for Python ([experiment configuration](https://docs.langchain.com/langsmith/experiment-configuration)). JavaScript support is UNVERIFIED.

### 3.8 Inspect AI (UK AI Security Institute)

The statistics reference among these tools. Python only.

```python
@task
def simpleqa():
    return Task(
        dataset=hf_dataset("codelion/SimpleQA-Verified", split="train",
            sample_fields=FieldSpec(input="problem", target="answer")),
        solver=generate(),
        scorer=model_graded_qa(),
    )
```

Run with `inspect eval simpleqa.py --model openai/gpt-5`, then `inspect view` ([Inspect](https://inspect.aisi.org.uk/)). Some whitespace in the snippet above is condensed.

**Scorers.** `includes`, `match`, `pattern`, `answer`, `exact`, `f1`, `model_graded_qa`, `model_graded_fact`, `choice` and `math` ([scorers](https://inspect.aisi.org.uk/scorers.html)).

- A `Score` has `value`, `answer`, `explanation` and `metadata`.
- Letter values are CORRECT "C", INCORRECT "I", PARTIAL "P" and NOANSWER "N", mapped to 1, 0, 0.5 and 0 ([custom scorers](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_ai/main/docs/custom-scorers.qmd)).

**Metrics**, verbatim ([metrics](https://inspect.aisi.org.uk/metrics.html)):

- `stderr()`: "Standard error of the mean". It "supports computing clustered standard errors via the `cluster` parameter".
- `bootstrap_stderr()`: "Standard deviation of a bootstrapped estimate of the mean. 1000 samples are taken by default".
- `ci()`: "Confidence interval for the mean … Defaults to a 95% Student-t interval (`mean ± t · stderr`, with `n - 1` degrees of freedom, or `clusters - 1` when `cluster=` is set); pass `level=` to change the confidence level or `method="bootstrap"` for a percentile (cluster) bootstrap interval."
- `ci_wilson()`: "Wilson score confidence interval for the mean of binary (0/1) scores … Prefer this over ci() for binary scores such as accuracy: the bounds always stay within [0, 1] and remain well calibrated for small samples and proportions near 0 or 1."
- Also `var()`, `std()`, `grouped()` and `krippendorff_alpha()` (agreement "across multiple judges or scorers").

**Epochs** (same page):

- `epochs=Epochs(5, "mode")`.
- Reducers: `mean`, `median`, `mode`, `majority`, `max`, `pass_at_{k}` ("Probability of at least 1 correct sample given `k` epochs"), `at_least_{k}` and `pass_k_{k}` ("Probability that all `k` epoch attempts succeed").

**Judge.** Precedence is an explicit `model=`, then the `grader` model role (`--model-role grader=openai/gpt-4o`), then the model under test. Passing a list of models makes a panel, where "A grade wins only when more than half of the panel returns it" ([model graded](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_ai/main/docs/model-graded.qmd)).

**CI.**

- `--fail-on-error` is a tolerance for sample errors, not for scores.
- `--retry-on-error` retries failed samples.
- There is no score-threshold gate ([options](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_ai/main/docs/options.qmd)).
- Early stopping can skip samples based on results so far ([early stopping](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_ai/main/docs/early-stopping.qmd)).

**Datasets.** `Sample(input, target, choices, id, metadata, files, setup)`. Readers are `csv_dataset`, `json_dataset` (JSON and JSONL) and `hf_dataset`, with fields mapped through `FieldSpec` or `record_to_sample` ([datasets](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_ai/main/docs/datasets.qmd)).

**Caching.**

- `GenerateConfig(cache=True)`, tuned with `CachePolicy(expiry="1W", per_epoch=...)`.
- The key covers model, base URL, messages, epoch, config and tools.
- Managed with `inspect cache list | clear | prune` ([caching](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_ai/main/docs/caching.qmd)).

**Logs and the viewer.**

- Logs are JSON with a published schema. For JavaScript, Inspect recommends JSON5, because "some `number` values will be `NaN` or `Inf`" ([eval logs](https://inspect.aisi.org.uk/eval-logs.html)).
- The viewer shows completed samples "along with incremental metric calculations", with Messages, Scoring and Metadata tabs per sample ([log viewer](https://raw.githubusercontent.com/UKGovernmentBEIS/inspect_ai/main/docs/log-viewer.qmd)).
- There is no side-by-side comparison of two logs.
- The terminal output appears only as screenshots in the docs (UNVERIFIED as text).

### 3.9 Ragas

- **API change.** `evaluate()` is deprecated in favour of an `@experiment()` decorator that writes CSV results to `experiments/` ([experimentation](https://docs.ragas.io/en/stable/concepts/experimentation/), [evaluate reference](https://docs.ragas.io/en/stable/references/evaluate/)).
- **Metrics.** RAG metrics (faithfulness, context precision and recall, response relevancy), agent metrics (tool call accuracy and F1, goal accuracy), text metrics, and general-purpose Aspect Critic and rubrics ([metrics](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/)).
- **Sample fields.** `user_input`, `response`, `retrieved_contexts`, `reference`, `rubric` ([eval sample](https://docs.ragas.io/en/stable/concepts/components/eval_sample/)).
- **Judge.** `llm_factory(model, provider, client)`.
- **Caching.** `DiskCacheBackend`, an exact-match cache in `.cache/` ([caching](https://docs.ragas.io/en/stable/howtos/customizations/_caching/)).
- **Cost.** `result.total_cost(cost_per_input_token=..., cost_per_output_token=...)` ([cost](https://docs.ragas.io/en/stable/howtos/applications/_cost/)).
- **Baseline.** `ragas evals --baseline <name>` ([CLI](https://docs.ragas.io/en/latest/howtos/cli/)).
- **Not documented:** thresholds, repeats and statistics.

Ragas matters to Retest mainly as a metric vocabulary; its TypeScript surface is none.

### 3.10 Opik (Comet)

**Writing an eval.** TypeScript ([TS quick start](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/quick-start)):

```typescript
const result = await evaluate({ dataset: retrievedDataset, task: llmTask,
  scoringMetrics: [new ExactMatch()], experimentName: "My First Evaluation",
  projectName: "my-project", scoringKeyMapping: { expected: "expected_output" } });
```

- A metric returns `{ name, value, reason }`. TypeScript metrics validate their input with a zod `validationSchema` ([TS metrics](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/metrics)).
- Python `trial_count` repeats tasks.
- `aggregate_evaluation_scores()` gives mean, min, max and std per metric ([evaluate](https://www.comet.com/docs/opik/evaluation/advanced/evaluate_your_llm)).

**Test suites**, the design closest to Retest ([building test suites](https://www.comet.com/docs/opik/evaluation/advanced/building-test-suites)):

```python
suite = opik_client.get_or_create_test_suite(
    name="customer-support-qa",
    project_name="test-suites-demo",
    global_assertions=[
        "The response is grounded in the provided documentation context",
        "The response directly addresses the user's question",
        "The response is concise (3 sentences or fewer)",
    ],
    global_execution_policy={"runs_per_item": 2, "pass_threshold": 2},
)
```

- A run passes if "all its assertions pass".
- An item passes when `runs_passed >= pass_threshold`.
- The pass rate is "the ratio of passed items to total items".
- "The LLM judge uses `input` and `output` to evaluate assertions."
- TypeScript has `createTestSuite({ globalExecutionPolicy: { runsPerItem, passThreshold } })` and `runTests(...)`, returning `passRate`, `itemsPassed` and per-item `runsPassed`/`runsTotal` ([TS test suites](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/test_suites)).
- These are plain-language criteria, the same idea as `toMeet`. Opik returns no evidence and has no third outcome.

**Console output**, verbatim from an issue in the official repo ([opik#1392](https://github.com/comet-ml/opik/issues/1392)):

```
╭─ My dataset (2 samples) ───────────╮
│                                    │
│ Total time:        00:00:02        │
│ Number of samples: 2               │
│                                    │
│ hallucination_metric: 0.5000 (avg) │
│                                    │
╰────────────────────────────────────╯
```

### 3.11 Langfuse

**Writing an eval.** `langfuse.experiment.run({ name, data, task, evaluators })` in TypeScript, then `await result.format()` ([experiments via SDK](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk)). The evaluator, verbatim:

```typescript
const accuracyEvaluator = async ({ input, output, expectedOutput }) => {
  if (expectedOutput && output.toLowerCase().includes(expectedOutput.toLowerCase())) {
    return { name: "accuracy", value: 1.0, comment: "Correct answer found" };
  }
  return { name: "accuracy", value: 0.0, comment: "Incorrect answer" };
};
```

- Run-level evaluators take `({ itemResults })`.
- autoevals scorers are wrapped with `createEvaluatorFromAutoevals`.

**CI gate.** The `langfuse/experiment-action` has `should_fail_on_regression` and an optional approved-baseline JSON of case verdicts. A script raises `RegressionError(metric=..., value=..., threshold=...)` ([CI/CD](https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd), [changelog 2026-05-25](https://langfuse.com/changelog/2026-05-25-experiment-ci-cd-gates)).

**Baseline.** A compare view with a chosen baseline shows "green/red deltas for scores, cost, and latency" ([changelog](https://langfuse.com/changelog/2025-11-06-compare-view-baseline-support)). There is no spread or significance.

**Datasets.** Items have `input`, `expectedOutput`, `metadata` and `sourceTraceId`. They are versioned, and a JSON Schema can be enforced ([datasets](https://langfuse.com/docs/evaluation/experiments/datasets)).

### 3.12 Arize Phoenix

**Writing an eval.** TypeScript `runExperiment({ dataset, task, evaluators, repetitions, concurrency, dryRun })`. An evaluator returns `{ label, score, explanation, metadata }` ([TS experiments](https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/experiments)).

In Python, evaluator arguments bind by name (`input`, `output`, `expected`, `reference`, `metadata`). An evaluator can return:

- a bool, a number or a label,
- a tuple `(score, label, explanation)`, or
- an `EvaluationResult` ([using evaluators](https://arize.com/docs/phoenix/datasets-and-experiments/how-to-experiments/using-evaluators)).

**CI in Vitest and Jest.** Entry points are `@arizeai/phoenix-client/vitest` and `@arizeai/phoenix-client/jest` ([vitest-jest](https://arize.com/docs/phoenix/evaluation/integrations/vitest-jest)). Acceptance criteria, verbatim ([CI evals](https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/ci-evals)):

```ts
acceptanceCriteria: [
  { annotationName: "token_f1", metric: "average", threshold: 0.8 },
  {
    annotationName: "token_f1",
    metric: "passRate",
    passFn: (a) => typeof a.score === "number" && a.score >= 0.7,
    minPassRate: 0.9,
  },
  {
    annotationName: "valid_sql",
    metric: "passRate",
    passFn: (a) => a.score === true,
    minPassRate: 1,
  },
  {
    annotationName: "latency_ms",
    metric: "average",
    threshold: 800,
    direction: "minimize",
  },
]
```

- **Repetitions.** "per-test `repetitions` → suite `repetitions` → `PHOENIX_TEST_REPETITIONS` → `1`".
- **On failure**, "the reporter prints an `Acceptance Criteria` block listing each criterion's observed value, the bar it needed to clear, and its sample count". The exact text is UNVERIFIED.
- **Exit codes** are not documented.
- **Cost.** Phoenix computes cost from OpenInference token-count attributes and a pricing table ([cost tracking](https://arize.com/docs/phoenix/tracing/how-to-tracing/cost-tracking)).
- **Statistics.** Averages only.

### 3.13 Pydantic Evals

Verbatim ([quick start](https://raw.githubusercontent.com/pydantic/pydantic-ai/main/docs/evals/quick-start.md)):

```python
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Contains, EqualsExpected

dataset = Dataset(
    name='uppercase_tests',
    cases=[
        Case(
            name='uppercase_basic',
            inputs='hello world',
            expected_output='HELLO WORLD',
        ),
        Case(
            name='uppercase_with_numbers',
            inputs='hello 123',
            expected_output='HELLO 123',
        ),
    ],
    evaluators=[
        EqualsExpected(),
        Contains(value='HELLO', case_sensitive=True),
    ],
)

def uppercase_text(text: str) -> str:
    return text.upper()

report = dataset.evaluate_sync(uppercase_text)
report.print()
```

**Evaluators.**

- A custom evaluator's `evaluate(ctx)` returns a bool (an assertion), a number (a score), a string (a label) or a dict of these ([custom evaluators](https://raw.githubusercontent.com/pydantic/pydantic-ai/main/docs/evals/evaluators/custom.md)). **Typing the return value is how Pydantic separates assertions from scores from labels**, and Retest can use the same idea.
- `LLMJudge(rubric=..., model=..., include_input=True)` ([LLM judge](https://raw.githubusercontent.com/pydantic/pydantic-ai/main/docs/evals/evaluators/llm-judge.md)).
- `evaluate_sync(task, repeat=5)` averages each case's runs first, then averages the case summaries ([multi-run](https://raw.githubusercontent.com/pydantic/pydantic-ai/main/docs/evals/how-to/multi-run.md)).
- `report.print(baseline=other)` prints a diff against a baseline ([reporting API](https://pydantic.dev/docs/ai/api/pydantic_evals/reporting/)). The diff layout is UNVERIFIED; issue [#7496](https://github.com/pydantic/pydantic-ai/issues/7496) shows cells like `+1.0 / -50.0%`.
- Report evaluators include ConfusionMatrix, PrecisionRecall and ROCAUC ([report evaluators](https://raw.githubusercontent.com/pydantic/pydantic-ai/main/docs/evals/evaluators/report-evaluators.md)). A confusion matrix is what an automatic labeler needs.

### 3.14 Other tools worth knowing

- **Mastra** (`@mastra/core/evals`). `runEvals` takes `scorers` with `{ scorer, threshold }` and `gates` that must score 1.0. It returns `verdict: 'passed' | 'scored' | 'failed'` ([docs](https://mastra.ai/reference/evals/run-evals)). Its "gates" are prior art for Retest's critical cases.
- **Vercel eve** (launched 17 Jun 2026). `eve eval` runs `evals/*.eval.ts` written as `defineEval({ async test(t) { await t.send(...); t.calledTool("run_sql"); t.check(t.reply, includes(...)) } })` ([blog](https://vercel.com/blog/introducing-eve)). Not re-fetched.
- **Laminar.** `evaluate({ data, executor, evaluators })`, run with `npx lmnr eval`; evaluators return numbers ([docs](https://laminar.sh/docs/evaluations/quickstart)).
- **W&B Weave.** Python `Evaluation(dataset, scorers, trials=3)`; TypeScript `new weave.Evaluation(...)` with `nTrials` ([Weave](https://docs.wandb.ai/weave/guides/core-types/evaluations)).
- **MLflow.** `mlflow.genai.evaluate(data, predict_fn, scorers=[Correctness(), Guidelines(...)])` ([MLflow](https://mlflow.org/docs/latest/genai/eval-monitor/)).
- **Google ADK.** `test_config.json` sets criteria such as `{"tool_trajectory_avg_score": 1.0, "response_match_score": 0.8}`, run with `adk eval` ([ADK](https://adk.dev/evaluate/)).
- **Harbor**, from the Terminal-Bench authors, is an agent-evaluation harness ([GitHub](https://github.com/harbor-framework/harbor)). Its attempts and result format are UNVERIFIED.

Not researched: Weave's TypeScript scorer signature in depth, Scorecard, Autoblocks, Hamming, AgentOps, and OpenAI Agents SDK evals.

## 4. Comparison matrix

"—" means not documented.

| | Scorer returns | Judge config | Gate and exit | Repeats | Per-case rule over repeats | Intervals or significance | Baseline | Call cache |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| promptfoo | bool, number or `{pass, score, reason}` | `--grader`, `defaultTest.options.provider`, per assertion | exit 100; `PROMPTFOO_PASS_RATE_THRESHOLD` | `--repeat` | — (PR open) | — | web diff; PR comment | disk, 14-day TTL |
| DeepEval | metric sets `score, success, reason` | `model=`, `deepeval set-*` | pytest exit code | `-r` (pytest-repeat) | — | — | Confident AI | metric results (`-c`) |
| evalite | number or `{score, metadata}` | per scorer (AI SDK model) | exit 1 below average threshold | `trialCount` | — | — | chevron vs last run | AI SDK wrapper |
| vitest-evals | `{score \| null, metadata}` | `judgeHarness` | Vitest failure below `judgeThreshold` | — | — | — | — | tool replay |
| Braintrust | number or autoevals `Score` | autoevals `init`, gateway | none built in (custom reporter) | `trialCount` | — | — | auto base, deltas and counts | gateway |
| LangSmith | `{key, score, comment}` | openevals `model` | Vitest assertions | `numRepetitions` | — | std dev in UI | red/green vs source | Python only |
| Inspect | `Score(value, answer, explanation)` | `model=`, `grader` role, panel | errors only | `epochs` | reducers incl. `pass_k_{k}`, `at_least_{k}` | **stderr, clustered, bootstrap, t and Wilson CI** | viewer history | on disk, per epoch |
| Opik | `{name, value, reason}` | `model=` (LiteLLM) | `run_tests` pass rate | `trial_count`, `runs_per_item` | **`pass_threshold`** | mean, min, max, std | UI side by side | — |
| Langfuse | `{name, value, comment}` | LLM connection | Action on regression | — | approved baseline | — | green/red deltas | — |
| Phoenix | `{label, score, explanation}` | `LLM(provider, model)` | acceptance criteria | `repetitions` | `passRate` via `passFn` | — | UNVERIFIED | — |
| Pydantic Evals | bool, number, label or dict | `LLMJudge(model=)` | — | `repeat` | averaged per case | — | `print(baseline=)` | — |

## 5. What a run looks like: the best real examples

Ranked by how much a developer learns from one glance.

**1. Braintrust's baseline summary.** One line per metric: value, delta, then improvements and regressions counted against the base run. Verbatim ([cookbook](https://www.braintrust.dev/docs/cookbook/recipes/EvaluatingChatAssistant)):

```
=========================SUMMARY=========================
86.67% (+26.67%) 'Factuality' score     (4 improvements, 0 regressions)

1.89s 'duration'        (5 improvements, 0 regressions)
0.01$ 'estimated_cost'  (4 improvements, 1 regressions)
```

and a regression:

```
=========================SUMMARY=========================
6.67% (-54.67%) 'Factuality' score      (0 improvements, 5 regressions)

4.77s 'duration'        (2 improvements, 3 regressions)
0.01$ 'estimated_cost'  (2 improvements, 3 regressions)
```

What it lacks: whether −54.67 points on five cases is noise. It cannot say. This output predates the `bt` CLI; whether `bt eval` prints the same block is UNVERIFIED.

**2. Pydantic Evals' case table.** A row per case, one glyph per assertion, duration, and an averages row. Verbatim ([quick start](https://raw.githubusercontent.com/pydantic/pydantic-ai/main/docs/evals/quick-start.md)):

```
                  Evaluation Summary: uppercase_text
┏━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━┳━━━━━━━━━━┓
┃ Case ID                 ┃ Assertions ┃ Duration ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━╇━━━━━━━━━━┩
│ uppercase_basic         │ ✔✔         │     10ms │
├─────────────────────────┼────────────┼──────────┤
│ uppercase_with_numbers  │ ✔✔         │     10ms │
├─────────────────────────┼────────────┼──────────┤
│ Averages                │ 100.0% ✔   │     10ms │
└─────────────────────────┴────────────┴──────────┘
```

**3. Phoenix's acceptance block.** Each gate prints its observed value, the bar and the sample count. Only the description is documented, not the text. Showing the sample count beside the gate is the right instinct, and an interval is the next step.

**4. vitest-evals' cost line**, from source. `app X tok / $X.XX | judge X tok / $X.XX | total X tok / $X.XX | N tools | M err`. It is the only tool that separates what the product spent from what grading spent.

**5. promptfoo.** The current summary, from source templates ([summary.ts](https://raw.githubusercontent.com/promptfoo/promptfoo/main/src/util/eval/summary.ts)); the block order is UNVERIFIED:

```
Results:
  ✓ {n} passed ({pct})
  ✗ {n} failed ({pct})
  ✗ {n} errors ({pct})
Duration: {duration} (concurrency: {n})
```

Real output from April 2025, before the redesign ([Simon Willison](https://simonwillison.net/2025/Apr/24/exploring-promptfoo/)):

```
Successes: 78
Failures: 47
Errors: 50
Pass Rate: 44.57%
```

The results table has variables as leading columns and one column per `[provider] prompt`, with cells prefixed `[PASS]`, `[FAIL]` or `[ERROR]` ([table.ts](https://raw.githubusercontent.com/promptfoo/promptfoo/main/src/table.ts)). promptfoo is the only tool that keeps *errors* apart from *failures* in its summary, and Retest should do the same.

**6. Opik's panel** (section 3.10) and **DeepEval's per-metric lines**, from source ([utils.py](https://raw.githubusercontent.com/confident-ai/deepeval/main/deepeval/evaluate/utils.py)):

```
  - ✅ {name} (score: {score}, threshold: {threshold}, strict: {strict_mode}, evaluation model: {model}, reason: {reason}, error: {error})
...
Overall Metric Pass Rates
{metric}: {pass_rate:.2%} pass rate
```

DeepEval prints the judge model and the reason next to every verdict, which is good. It also prints a line pointing to its paid product after every table, which Retest should not do.

**7. evalite's summary**, rebuilt from source; layout UNVERIFIED ([rendering.ts](https://raw.githubusercontent.com/mattpocock/evalite/main/packages/evalite/src/reporter/rendering.ts)):

```
      Score  85%
  Threshold  80% (passed)
 Eval Files  1
      Evals  3
   Duration  150ms
```

**LangSmith's Vitest reporter**, from source ([reporter.ts](https://raw.githubusercontent.com/langchain-ai/langsmith-sdk/main/js/src/utils/jestlike/reporter.ts)):

- A table `Test | Inputs | Reference Outputs | Outputs | Status | <feedback keys>`, with `✓ Passed`, `✕ Failed` and `○ Skipped`.
- **Scores are coloured by their distance from the mean in standard deviations.**

## 6. AI-driven end-to-end testing tools

### 6.1 Midscene.js

The README snippet, verbatim ([repo](https://github.com/web-infra-dev/midscene)):

```js
const agent = new PlaywrightAgent(page);
await agent.aiAct('Search for headphones, then filter the results to under $100');
await agent.aiWaitFor('The filtered search results are displayed');
await agent.aiAssert('Every product in the search results has a price below $100');
```

**API** ([API](https://midscenejs.com/api.html)):

- Assertion signature: `aiAssert(assertion, errorMsg?, options?)`.
- Options include `domIncluded` (off by default) and `screenshotIncluded` (on by default). The model judges from a screenshot unless told otherwise.
- The docs: "If the assertion fails, the SDK throws an error that includes both the optional `errorMsg` and a detailed reason generated by the AI."
- The docs themselves advise "combine `.aiQuery` with standard JavaScript assertions when you need deterministic checks".
- The thrown message, from source, is `` `Assertion failed: ${message || assertionText}\nReason: ${thought || '(no_reason)'}` `` ([insight.ts](https://raw.githubusercontent.com/web-infra-dev/midscene/main/packages/core/src/agent/insight.ts)).
- `aiWaitFor` polls every 3 s for up to 15 s by default.

**Caching**, verbatim ([caching](https://midscenejs.com/caching.html)):

- "The query results like `aiBoolean`, `aiQuery`, `aiAssert` will never be cached."
- Plans from `ai`/`aiAct` and element XPaths are cached. "Cache contents will be saved in the `./midscene_run/cache` directory with the `.cache.yaml` as the extension name."
- A cached location is invalid when the element's text or the DOM structure has changed, and a miss falls back to the model.
- Strategies are `read-write`, `read-only` and `write-only`.

**Reporting.**

- One HTML report per agent with a replay of every step and its screenshots, under `midscene_run/report`.
- A Playwright reporter.
- A `report-tool` that converts reports to Markdown ([consume report](https://midscenejs.com/consume-report-file)).
- `MIDSCENE_RECORD_MODEL_CALL=true` logs model calls to JSONL ([observability](https://midscenejs.com/model-debugging-observability)).

**Models.** `MIDSCENE_MODEL_NAME`, `MIDSCENE_MODEL_BASE_URL` and `MIDSCENE_MODEL_API_KEY`, plus separate `INSIGHT` (assertions and queries) and `PLANNING` overrides ([model config](https://midscenejs.com/model-config.html)). Any OpenAI-compatible endpoint works. **The judge model is configured apart from the acting model**, and Retest should keep that split.

### 6.2 Stagehand (v4)

- **Snippets.** `await stagehand.act("click on add to cart")` and `await stagehand.extract("extract the name of the repository", z.object({ name: z.string() }))` ([act](https://docs.stagehand.dev/v4/basics/act), [extract](https://docs.stagehand.dev/v4/basics/extract)).
- **Assertions.** There is no assert primitive. Teams use `extract` plus `expect` (per Momentic's comparison page, [Momentic vs Stagehand](https://momentic.ai/docs/comparisons/stagehand)).
- **What the model sees.** `extract` reads the accessibility tree and DOM; a screenshot is opt-in.
- **Caching** ([caching](https://docs.stagehand.dev/v4/best-practices/caching)):
  - `act`, `observe` and `extract` are cached **server-side** by Browserbase, keyed on instruction, page content and options.
  - A `threshold` sets how many identical results are needed before the cache serves.
  - With a local browser, "the `cache` option has no effect and every call runs inference".
  - Every call returns its cache status and miss reason.
  - Whether `extract` caching is on by default is UNVERIFIED. If it is, a verification built on `extract` can return a stale answer.
- **Other.** `selfHeal` re-infers an action when a recorded selector breaks.

### 6.3 Magnitude and Shortest (both dormant)

**Magnitude.** `test('example', async (agent) => { await agent.act('Log in'); await agent.check('Dashboard is visible'); })` ([docs source](https://raw.githubusercontent.com/magnitudedev/browser-agent/main/docs/testing/building-test-cases.mdx)).

- `check` sends a screenshot plus the action history and expects `{ reasoning, passed }`.
- On failure it throws `Check failed: <description>`, and the reasoning does **not** reach the error ([agent source](https://raw.githubusercontent.com/magnitudedev/browser-agent/main/packages/magnitude-test/src/agent/index.ts)).
- The CLI exits 1 on any failure.
- Deterministic caching is "in progress".

**Shortest.** `shortest("Login to the app using email and password", {...})`. The model returns `status: "passed" | "failed"` with a `reason` ([runner](https://raw.githubusercontent.com/antiwork/shortest/main/packages/shortest/src/core/runner/index.ts)).

- The cache in `.shortest/cache/` keeps the last passing run's steps.
- A replay that completes calls `markPassedFromCache({ reason: 'All actions successfully replayed from cache' })`, **so the check is not judged again**.

### 6.4 Playwright

Test Agents (1.56+): a planner, a generator ("verifies selectors and assertions live") and a healer. The healer "Re-runs the test until it passes or until guardrails stop the loop", and its output is "A passing test, or a skipped test if the healer believes that functionality is broken" ([test agents](https://playwright.dev/docs/test-agents)).

- **No AI runs at test time.** There is no `page.ai` and no AI matcher up to 1.63 ([release notes](https://playwright.dev/docs/release-notes)).
- **MCP testing tools** (`browser_verify_text_visible` and others) are deterministic. Each "records the matching `expect(...)` line in the generated code" ([MCP assertions](https://playwright.dev/mcp/tools/assertions)).

### 6.5 Commercial tools

**Momentic.**

- An `assert:` step in plain language is judged against "the DOM, accessibility tree, and a screenshot of the viewport". The docs advise "under 20 words; split compound assertions" ([writing assertions](https://momentic.ai/docs/core-concepts/writing-assertions)).
- AI check and AI extract are never cached ([step cache](https://momentic.ai/docs/reliability/step-cache)).
- "Memory" seeds AI checks "with traces from past successful runs", which trades independence for consistency ([memory](https://momentic.ai/docs/ai/memory)).
- Failure classification assigns heal, warn or fail, and quarantine keeps a flaky test running "without letting it block CI" ([auto-maintenance](https://momentic.ai/docs/reliability/auto-maintenance)).

**Octomind** (appears discontinued). It split each prompt into intent, instructions and "EXPECTED OUTCOME", and auto-fix proposed a patch for a person to approve ([archived docs](https://raw.githubusercontent.com/OctoMind-dev/mintlify-docs/main/maintain-tests/auto-fix.mdx)).

**QA Wolf.** AI writes and maintains Playwright or Appium code, and claims no variance because the code "can't improvise or hallucinate". There is no AI at runtime ([automation AI](https://www.qawolf.com/automation-ai)).

**Others.**

- **Browser Use.** Its judge is on by default and returns `{ reasoning, verdict, failure_reason, impossible_task, reached_captcha }` ([judge.py](https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/agent/judge.py)).
- **Skyvern.** Separates `failed` ("System error") from `terminated` ("AI determined the goal is unachievable") ([error handling](https://www.skyvern.com/docs/developers/going-to-production/error-handling)).
- **KaneAI.** Has "Warn and Continue" ([assertions](https://www.testmuai.com/support/docs/kaneai-kb-assertions-and-validation/)).
- **testRigor.** `check that page '...' using ai` ([blog](https://testrigor.com/blog/how-to-automate-testing-of-ai-features/)).
- **Checksum** and **Autify** keep assertions deterministic.
- **Vercel agent-browser.** An AI judge was proposed and "Closed as not planned" ([#1950](https://github.com/vercel-labs/agent-browser/issues/1950)).

### 6.6 What the E2E tools teach Retest

| Question | Answer from the field |
| --- | --- |
| Cache AI assertions? | No. Midscene and Momentic say so explicitly. Shortest and possibly Stagehand's server cache can return a verdict nobody re-judged. |
| What does the judge see? | A screenshot (Midscene by default, Magnitude); the DOM and accessibility tree (Stagehand); all three (Momentic, KaneAI). |
| Failure message | Midscene: `Assertion failed: <text>\nReason: <model thought>`. Magnitude drops the reason. |
| Third outcome | None named "inconclusive". Skyvern `terminated`, Browser Use `impossible_task`, Momentic `warn`, KaneAI "Warn and Continue", Playwright healer "skipped". |
| Evidence in verdicts | Free-text reasoning only. No tool asks for a quote or checks one. |
| Model split | Midscene separates the insight (judge) model from the planning model. |

## 7. Statistical rigour

### 7.1 Published guidance

- **Miller, "Adding Error Bars to Evals" (Anthropic, Nov 2024)** ([arXiv](https://arxiv.org/abs/2411.00640), [Anthropic summary](https://www.anthropic.com/research/statistical-approach-to-model-evals)). Five recommendations:
  1. Report the standard error of the mean, with "mean ± 1.96 × SEM" as the 95% interval.
  2. "cluster standard errors on the unit of randomization"; clustered errors can be over three times the naive ones.
  3. Resample answers several times and "use question-level averages as the question scores".
  4. Use paired differences between models on the same questions.
  5. Use power analysis to decide how many questions are needed.
- **Bowyer, Aitchison and Ivanova, "Don't use the CLT in LLM evals with fewer than a few hundred datapoints" (ICML 2025)** ([arXiv](https://arxiv.org/abs/2503.01747), [HTML](https://arxiv.org/html/2503.01747)).
  - Below a few hundred items, normal-approximation intervals are too narrow. The paper recommends "WS [Wilson score] or Bayesian intervals".
  - For clustered questions, "only the Bayesian method based on a clustered model achieves the right coverage".
  - For two models on the same questions, "the paired Bayes method".
  - Library: [bayes_evals](https://github.com/sambowyer/bayes_evals).
- **Anthropic, "Demystifying evals for AI agents" (9 Jan 2026)** ([post](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)):
  - Defines task, trial, grader, transcript and outcome.
  - Defines pass@k ("at least one correct solution in k attempts") and pass^k ("the probability that all k trials succeed"), with the example that 75% per trial gives "(0.75)³ ≈ 42%".
  - On judges: give the judge an "Unknown" way out; grade each rubric dimension "with an isolated LLM-as-judge"; calibrate against human experts; "grade what the agent produced, not the path it took".
  - Regression evals "should have a nearly 100% pass rate".
  - It gives no interval guidance.
- **Yao et al., τ-bench (June 2024)** introduced pass^k to "evaluate the reliability of agent behavior over multiple trials", with GPT-4o at "pass^8 <25% in retail" ([arXiv](https://arxiv.org/abs/2406.12045)).
- **Chen et al., "Evaluating Large Language Models Trained on Code" (2021)** defined the unbiased estimator `pass@k := E[1 − C(n−c, k) / C(n, k)]` for n samples with c correct. It notes that `1−(1−p̂)^k` "is biased" ([ar5iv](https://ar5iv.labs.arxiv.org/html/2107.03374)). The matching unbiased pass^k estimator is `C(c, k) / C(n, k)`. That formula is derived here, not quoted from the τ-bench paper (UNVERIFIED as their exact form).
- **OpenAI evaluation best practices.** Prefer "pairwise comparison or pass/fail for more reliability" and calibrate the judge before scaling. No statistics ([guide](https://developers.openai.com/api/docs/guides/evaluation-best-practices)).
- **Hamel Husain, LLM-as-a-judge guide** (updated 1 Sep 2026). Binary pass/fail with a written critique beats 1–5 scales. To measure a judge against human labels, report the true positive rate and true negative rate, not raw agreement ([post](https://hamel.dev/blog/posts/llm-judge/)).
- **Stats for LLM Evals** (Ian Arawjo) is a living guide aimed at 20–100-item evals, with an `evalstats` library that corrects for multiple comparisons ([site](https://statsforevals.com/)). It is incomplete.

### 7.2 What the tools do

| Tool | Per-case spread | Interval on a rate | Clustered | Paired or significance between runs | pass@k / pass^k |
| --- | --- | --- | --- | --- | --- |
| Inspect | epochs + `std`/`var` | `ci()` (t, bootstrap), `ci_wilson()` | `stderr(cluster=)` | none | `pass_at_{k}`, `pass_k_{k}`, `at_least_{k}` |
| Opik | mean, min, max, std | none | none | none | per-item `pass_threshold` |
| LangSmith | std dev across repetitions (UI) | none | none | none | none |
| Braintrust | trials grouped by input | none | none | counts of improvements and regressions | none |
| Phoenix | average over repetitions | none | none | none | `passRate` via `passFn` |
| promptfoo | none | none | none | none | pass^N in an open PR |
| DeepEval | none | none | none | none | HumanEval only |
| evalite, vitest-evals, Langfuse, Ragas, Pydantic Evals | averages | none | none | none | none |

### 7.3 Numbers Retest's docs should show

Computed here with the Wilson score interval at 95%:

| Passed / cases | Rate | 95% Wilson interval |
| --- | --- | --- |
| 9 / 10 | 90% | 60% – 98% |
| 10 / 10 | 100% | 72% – 100% |
| 20 / 20 | 100% | 84% – 100% |
| 46 / 50 | 92% | 81% – 97% |
| 92 / 100 | 92% | 85% – 96% |
| 184 / 200 | 92% | 87% – 95% |
| 460 / 500 | 92% | 89% – 94% |
| 920 / 1000 | 92% | 90.2% – 93.5% |

- A labeler that scores 92% on 50 cases has not shown it beats 90%. With a true rate of 92%, it takes about 1,000 cases before the lower bound clears 90%.
- `pass: { accuracy: 0.9 }` therefore needs defined semantics: the point estimate, or the lower bound. Sections 9.2 and 9.3 cover this.
- Ten critical cases passing every time shows only that their true pass rate is above about 72%.

## 8. Interoperability

### 8.1 Scorer argument shapes

| Library | Arguments | Expected-output name | Return |
| --- | --- | --- | --- |
| autoevals / Braintrust | `{ input, output, expected, metadata, ...extra }` | `expected` | `{ name, score: 0..1 \| null, metadata? }` or a number (Braintrust) |
| evalite | `{ input, output, expected }` | `expected` | number or `{ score, metadata? }` |
| vitest-evals (legacy) | `{ input, output, expected }` | `expected` | `{ score, metadata? }` |
| vitest-evals judges | `ctx { input, output, toolCalls, run, session }` | per judge | `{ score \| null, metadata: { rationale? } }` |
| promptfoo | `(output, context{ vars, prompt, test, ... })` | `context.vars` / assertion `value` | bool, number or `{ pass, score, reason, namedScores?, componentResults? }` |
| LangSmith / openevals | `{ inputs, outputs, referenceOutputs, run, example }` | `referenceOutputs` | `{ key, score \| value, comment? }` |
| Langfuse | `{ input, output, expectedOutput, metadata }` | `expectedOutput` | `{ name, value, comment? }` |
| Phoenix (TS) | `{ input, output, expected, metadata }` | `expected` | `{ label?, score?, explanation?, metadata? }` |
| Opik (TS) | `score(input)` with zod-validated keys | `expected_output` via mapping | `{ name, value, reason }` |
| Inspect | `(state, target)` | `target` | `Score(value, answer, explanation, metadata)` |
| Pydantic Evals | `ctx { inputs, output, expected_output, metadata, duration }` | `expected_output` | bool, number, string or dict |
| OpenAI graders | `grade(sample, item)` | `item.*` | float |
| OpenTelemetry | event `gen_ai.evaluation.result` | n/a | `name`, `score.value`, `score.label`, `explanation` |

**Retest should accept the autoevals shape as its native scorer signature.** A scorer is called with one object:

```ts
type ScorerInput<Input, Output, Expected> = {
  input: Input
  output: Output
  expected?: Expected
  metadata?: Record<string, unknown>
}
```

The return should be a union that Retest normalises, told apart by its keys:

```ts
type ScorerReturn =
  | boolean                                            // assertion (Pydantic Evals, promptfoo)
  | number                                             // 0..1 score (Braintrust, evalite, promptfoo)
  | { name?: string; score: number | null; metadata?: object }             // autoevals, evalite, vitest-evals
  | { pass: boolean; score?: number; reason?: string; componentResults?: unknown[] } // promptfoo GradingResult
  | { name: string; value: number | boolean | string; comment?: string; reason?: string } // Langfuse, Opik
  | { key: string; score?: number | boolean; value?: unknown; comment?: string }       // LangSmith, openevals
  | { label?: string; score?: number; explanation?: string }                          // Phoenix, OTel
```

What this covers:

- **Used unchanged:** autoevals scorers (`Factuality`, `Levenshtein` and the rest), Braintrust scorers, evalite 0.x scorers and vitest-evals legacy scorers. Their argument names already match.
- **Return shapes normalised:** promptfoo's exported graders (`assertions.matchesLlmRubric(...)` returns a `GradingResult`), Langfuse, Opik, openevals and Phoenix results.
- **Argument renaming:** LangSmith/openevals (`outputs`, `referenceOutputs`) and Langfuse (`expectedOutput`) need it. There are two ways to handle that:
  - Also pass those keys as aliases on the scorer argument. This is free at runtime but crowds the type.
  - Ship three one-line adapters (`fromLangSmith`, `fromLangfuse`, `fromPhoenix`). This keeps the type clean and is the better choice.
- **What `score: null` means.** In autoevals it means "not applicable", for example no expected value. Braintrust leaves null scores out of averages. Retest should count these as *not scored* and show the count, not treat them as inconclusive.

Retest's own verdict record should be a superset that round-trips to all of these:

```ts
type Verdict = {
  name: string
  outcome: 'passed' | 'failed' | 'inconclusive' | 'not-scored'
  score?: number            // 0..1
  label?: string
  reason?: string
  evidence?: { quote: string; start: number; end: number }[]  // Retest-only
  judge?: { provider: string; model: string; tokens?: { input: number; output: number }; costUsd?: number; latencyMs: number }
  metadata?: Record<string, unknown>
}
```

### 8.2 promptfoo-style assertions

Retest cannot depend on promptfoo (it has zero runtime dependencies). There are three levels of compatibility:

1. **A user calls promptfoo inside a Retest scorer.** Retest normalises the returned `GradingResult`. This works with no Retest code beyond return normalisation.
2. **Retest implements the deterministic promptfoo assertion objects natively.** `{ type: 'contains' | 'icontains' | 'equals' | 'regex' | 'starts-with' | 'contains-any' | 'contains-all' | 'is-json' | 'contains-json' | 'levenshtein' | 'latency' | 'cost', value, threshold?, weight? }` with the `not-` prefix. All of them are small and dependency-free, and teams can then paste `assert:` lists across. `llm-rubric` maps onto `toMeet` with one criterion. `similar`, `bleu`, `rouge-n` and `meteor` need embeddings or tokenisers; leave them to user scorers.
3. **Import, not run, a promptfoo YAML file.** A converter reads `tests:` and `assert:` and writes Retest cases and scorers. This is a one-way migration path for teams leaving OpenAI Evals through promptfoo.

Do not copy promptfoo's rule that a grader reply without `pass` counts as passing ([llm-rubric](https://raw.githubusercontent.com/promptfoo/promptfoo/main/site/docs/configuration/expected-outputs/model-graded/llm-rubric.md)). A malformed judge reply should be inconclusive.

### 8.3 Dataset formats

The common denominator is one JSON object per case with `input`, an optional `expected`, and `metadata`. Retest should:

- **Accept inline arrays, sync and async functions, and async iterables.** These are used by evalite, Braintrust and LangSmith.
- **Read JSONL natively**, one case per line: `{ "id"?, "input", "expected"?, "metadata"?, "tags"?, "critical"? }`. This matches Braintrust's `bt datasets create --file records.jsonl` (`id, input, expected, metadata, tags`; [datasets](https://www.braintrust.dev/docs/annotate/datasets/create)) and Inspect's `json_dataset`.
- **Map common aliases on read:**
  - `expected_output` / `expectedOutput`: DeepEval, Langfuse, Pydantic Evals.
  - `target`: Inspect.
  - `reference` / `referenceOutputs`: Ragas, LangSmith.
  - `{ "item": {...} }` wrapper: OpenAI Evals.
  - `user_input` / `response`: Ragas.

  Report which mapping was applied.
- **Read CSV**, with `input` and `expected` columns plus promptfoo's `__expected` convention for import. Rows are strings, so validation through the case schema matters.
- **Validate every case against a Standard Schema.** The spec encourages authors to "copy/paste the code block", so tools can accept Zod, Valibot or ArkType schemas without a runtime dependency ([standardschema.dev](https://standardschema.dev/)). Opik already validates metric inputs with zod ([TS metrics](https://www.comet.com/docs/opik/reference/typescript-sdk/evaluation/metrics)). A case that fails validation is reported with its line number before any model is called.
- **Give each case a stable `id`,** from the file or a content hash. Baselines, flip rates and paired comparisons all need it. Braintrust groups trials by identical `input`, and DeepEval matches by name or input.

### 8.4 Report formats

- **JUnit XML** for CI dashboards. promptfoo writes `junit.xml` ([command line](https://www.promptfoo.dev/docs/usage/command-line/)). JUnit has no inconclusive state; map it to `<skipped message="inconclusive: …">`, or to `<error>` if the team asks for strictness.
- **CTRF** JSON test reports allow `passed`, `failed`, `pending`, `skipped` and `other` statuses, and are extendable ([CTRF](https://ctrf.io/docs/specification/overview)). `other`, plus an extension field, can carry inconclusive.
- **OpenTelemetry.** The `gen_ai.evaluation.result` event (status **Development**) has attributes:
  - `gen_ai.evaluation.name` (required).
  - `gen_ai.evaluation.score.value` (double) and `gen_ai.evaluation.score.label` ("SHOULD have low cardinality"), both conditionally required.
  - `gen_ai.evaluation.explanation`, `gen_ai.response.id` and `error.type`.

  Sources: [gen-ai-events.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-events.md). The GenAI conventions moved to their own repository ([semconv](https://opentelemetry.io/docs/specs/semconv/gen-ai/)). Inference spans use `gen_ai.operation.name`, `gen_ai.provider.name` (which replaced `gen_ai.system`), `gen_ai.request.model`, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` ([gen-ai-spans.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md)).

  Retest should write its judge calls and verdicts in the JSON report **with these attribute names**. It should not take an OpenTelemetry dependency; a later exporter can map one to one. Use `score.label` values `passed`, `failed` and `inconclusive`. The status is Development, so pin the semconv version in the report.

## 9. What Retest should add that none of them do

Ordered by how much each would matter to a developer and how clearly it is unclaimed.

1. **A counted third outcome.**
   - A `toMeet` verdict is passed, failed or inconclusive. So is a dataset gate.
   - Inconclusive covers:
     - a judge reply that does not parse;
     - a judge that says it cannot tell (Anthropic's "Unknown" advice);
     - a quote that is not in the answer;
     - a provider error after retries;
     - an interval that straddles the threshold (see item 3).
   - Report it apart from failures and errors, as promptfoo does for errors, and never fold it into either.
   - The CI rule for inconclusive is an explicit option. By default the run fails and says why, so nothing inconclusive passes silently.
   - Prior art exists in classic test frameworks: NUnit and MSTest `Assert.Inconclusive` ([NUnit](https://docs.nunit.org/articles/nunit/writing-tests/assertions/classic-assertions/Assert.Inconclusive.html), [MSTest](https://learn.microsoft.com/en-us/dotnet/api/microsoft.visualstudio.testtools.unittesting.assert.inconclusive)). No AI eval tool has it.
2. **Evidence that is checked.**
   - Each verdict must quote the answer word for word, and Retest checks every quote mechanically against the settled answer text. Use exact substring matching after a documented whitespace normalisation.
   - A missing or invented quote makes the verdict inconclusive.
   - The report prints the quote with its position.
   - Today every tool returns free-text reasoning at most, and Magnitude drops even that from the error.
3. **Intervals by default, and gates that know about them.**
   - Every rate prints with a 95% Wilson interval. The optional exact method is Clopper–Pearson, or Beta–Binomial with a uniform prior, as Bowyer et al. recommend for small n.
   - Clustered intervals when cases carry a `group`, following Miller's advice.
   - `pass: { accuracy: 0.9 }` should mean what the user thinks, and the output should say what it means. A workable default:
     - **passed** when the lower bound ≥ 0.9;
     - **failed** when the upper bound < 0.9;
     - **inconclusive** otherwise, with a line that says how many more cases would settle it.
   - This choice is taste-critical and needs a founder decision. A point-estimate gate that prints the interval and warns "not enough cases to tell" is the gentler alternative.
   - Inspect has the intervals but no gate; everyone else has gates without intervals.
4. **Paired comparison with the base run.**
   - Retest keys cases by `id` and compares the same cases across two runs. It reports:
     - the per-case transitions (passed→failed, failed→passed);
     - the paired difference with an interval, or McNemar's test for binary outcomes.
   - Braintrust's "4 improvements, 0 regressions" line is the best output today, and it cannot tell noise from change.
   - It stays local: the base is the last run's JSON report or a file in git. No account is needed, unlike Braintrust, LangSmith, Langfuse and Confident AI.
5. **Flip rate as a first-class number.**
   - With `repeat: n`, report per case how many runs passed.
   - Report the share of cases whose outcome changed across runs, and list the flipping cases by name.
   - Report pass@k and pass^k with the unbiased estimators.
   - Critical cases require n/n. Inspect has pass_k reducers and Opik has a per-item threshold, but nobody lists "these 4 cases flipped", which is what a developer acts on.
6. **Verdicts are never cached; subjects can be recorded.**
   - The judge always runs. This follows Midscene and Momentic and avoids the Shortest and Stagehand traps.
   - The system under test's model calls, or its tool calls in vitest-evals' style, may be recorded and replayed. The report says which parts were replayed.
   - A cached subject with a repeat count prints a warning, because promptfoo's per-repeat namespaces show that repeated runs over a cache measure nothing.
7. **Judge cost and product cost reported apart,** as vitest-evals does, and a budget that stops a run before it overspends. Inspect has cost limits. Tokens use the OpenTelemetry names.
8. **Power hints.**
   - When a gate is inconclusive, or a baseline difference is not significant, say how many cases would be needed. Miller's fifth recommendation covers this.
   - No tool does it, and it turns a statistics lesson into a concrete next step.
9. **Judge calibration against labelled cases** (lower priority). A `retest judge check` command runs the judge over cases with human verdicts and reports the true positive rate and true negative rate, per Hamel Husain's advice. Inspect's `krippendorff_alpha` covers agreement between several judges; whether any hosted tool offers this under another name is UNVERIFIED.
10. **One runner for browser tests and evals, with no account.** Opik and Phoenix are the nearest to `toMeet` and `test.eval`, and both report into their platform. Retest runs locally, writes files, and gates in CI on its own.

**Prior art to credit rather than claim:**

- critical cases: Mastra's "gates" that must score 1.0, and Opik's per-item `pass_threshold`;
- repeat reducers: Inspect;
- acceptance blocks: Phoenix;
- baseline counts: Braintrust;
- splitting the judge model from the acting model: Midscene.

### 9.1 A sketch of the output this implies

This is a proposal for discussion, not something any tool prints. It combines Pydantic's case table, Braintrust's baseline line, Phoenix's acceptance block and promptfoo's separate error count, and adds intervals, flips and evidence.

```
labeler.eval.ts  › automatic labeler                       200 cases × 3 runs

  accuracy   92.0%  [87.4 – 95.0]   needs ≥ 90.0%   inconclusive
             base 94.5% · paired change −2.5 pts [−5.8 – +0.8] · 7 worse, 2 better
             about 1,000 cases would settle this at the current rate
  critical   12 / 12 cases passed 3 of 3 runs                       passed
  flips      9 cases changed outcome between runs: refund-17, refund-42, …
  judge      0 unreadable replies · 1 quote not in the answer (case tax-03)

  product    412k tokens · $1.84        judge  96k tokens · $0.31     4m 12s
```

## 10. Could not verify, most important first

1. **Whether Stagehand v4 caches `extract()` by default on Browserbase.** This decides whether a Stagehand verification can return a stale verdict. Evidence is a PR and search snippets ([caching](https://docs.stagehand.dev/v4/best-practices/caching), [PR #2964](https://github.com/browserbase/stagehand/pull/2964)).
2. **The exact current terminal output of promptfoo, evalite, vitest-evals, DeepEval and LangSmith's reporter.** These were rebuilt from source templates; block order and spacing are unconfirmed. The Braintrust summary is verbatim but predates the `bt` CLI.
3. **Phoenix's Acceptance Criteria block text and its exit codes.** Only the description is documented.
4. **Inspect's terminal output as text.** The docs show screenshots only.
5. **Whether any hosted tool (LangSmith, Braintrust, Confident AI) computes significance between experiments.** Official docs show none, and one third-party course claims LangSmith does.
6. **Pydantic Evals' baseline diff table layout.** Known only from an issue.
7. **The pass^k estimator `C(c,k)/C(n,k)` as τ-bench's exact published form.** Derived here, not quoted from the paper.
8. **Default judge models** of DeepEval and promptfoo, and evalite's effective default `scoreThreshold`.
9. **Whether vitest-evals' new judges accept autoevals scorers.** The legacy API does. The GitHub Action inputs (`min-pass-rate`) were not re-fetched.
10. **OpenAI `string_check` operator `ne` versus `neq`.** The guide and the reference disagree.
11. **Confident AI's regression view wording.** It came from a search snippet after a 404.
12. **Octomind's discontinuation.** It rests on a third-party review, an archived docs repo and an unresolved domain.
13. **Not researched:** Scorecard, Autoblocks, Hamming, AgentOps, OpenAI Agents SDK evals, Qodo, and Harbor's result format.
