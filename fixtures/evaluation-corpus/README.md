# Evaluation corpus

A fixed set of labelled cases for Retest's AI checks: text, screenshots and frame sequences captured from Retest's own fixture apps, each with a requirement written before any judge saw it and a label for the verdict a judge that reads the evidence correctly would give. `scripts/run-evaluation-corpus.ts` runs the corpus against a named judge configuration and applies the [gates](#gates) below. The gates hold on this corpus only. They make no claim about how a judge does on anything else.

## What is here

| Path | What it is |
| --- | --- |
| `cases.json` | The case list: id, category, what each case probes, where its evidence came from, the requirement with its explicit criterion kind, the evidence, and the label with the reason for it |
| `captures/` | The evidence: screenshots, page text, Chrome screencast frames with a manifest per scene, diagnostics artifacts, and native captures of TaskPhone and TaskDesk; `capture-browsers.json` names each browser build |
| `capture/` | The scenes (the task app's own page with one controlled change each) and the script that captured the browser evidence |
| `runner/` | Reading the case list, freezing a case's evidence as a run's parent would, the frame store stand-in, the run loop and the scorer |
| `judges/` | Four fake judges and their config, for proving the runner without a model |

## How a case is judged

Each case goes through the code a run's check uses: the request is built by `buildRequest` with Retest's instructions, frames go through `gatherFrames` against a stand-in of the media process's frame store that answers from the captured frames, diagnostics through `gatherDiagnostics`, the answer through `readAnswer`, and the verdict through `settle`, which applies the parent's frame rules. Each criterion declares `state`, `seen` or `never`; its wording never chooses the rule. A state judges the last frame held and may pass or fail. A seen requirement passes only with a seen frame showing the appearance; without one it is inconclusive, never fail. A never requirement fails with a seen violation and passes only on complete capture. Missing frames set aside every pass and every state failure. Only a never failure citing a seen frame stands over missing frames. The call budget and concurrency bound of a run are not applied; cases run one at a time.

## Rubric

A label is the verdict of the whole check, from what the evidence shows, not from what the app was meant to do.

- **pass**: the evidence plainly shows every criterion met.
- **fail**: the evidence plainly shows a state criterion not met in the last frame held, or a seen frame violates a never criterion. A seen criterion never fails.
- **inconclusive**: the evidence cannot show whether the criterion is met: it is covered, cut off, out of view, missing frames, or no seen frame witnesses a seen requirement. Partial capture also leaves a never requirement inconclusive unless a frame witnesses its violation. A case whose evidence Retest cannot gather is inconclusive or an error as a run would end it.

Each label also says:

- **unambiguous**: a careful reader would not disagree. Only unambiguous cases labelled pass or fail count towards the 90% gate.
- **critical**: a pass on this case is never acceptable, because the evidence shows a known failure or cannot show what the requirement asks. A known critical failure must never pass.
- **review**: every label is `awaiting-founder` until the founder has reviewed it. While any label awaits review, a met gate is reported as provisional.
- **why**: what in the evidence decides the label.

Kinds: `clear-pass`, `clear-failure`, `incomplete-evidence`, `clipped-content`, `plausible-wrong-text`, `missing-transient-event`, `prompt-injection`. A case may probe more than one.

## Gates

Applied by `runner/score.ts`:

1. A case labelled critical never ends `pass` in any repeat.
2. On unambiguous cases labelled pass or fail, at least 90% of judgments are correct. An inconclusive or error judgment there is not correct.

Missing, duplicate and out-of-range case/repeat results are refused before scoring.

The run also reports false passes, false failures, inconclusive and error rates, repeat agreement (the share of cases whose repeats all ended the same), latency of each call and the tokens a provider counted.

## Running it

Offline, with the fake judges (from the Retest root):

```sh
node --conditions=retest-source scripts/run-evaluation-corpus.ts --config fixtures/evaluation-corpus/judges/retest.config.ts --judge perfect
```

Against a real judge, from a project where the judge's adapter and its packages are installed, with the key typed into the shell for one run and kept out of every file:

```sh
read -rs RETEST_EVALUATION_AZURE_KEY && export RETEST_EVALUATION_AZURE_KEY
node --conditions=retest-source scripts/run-evaluation-corpus.ts --config <project>/retest.config.ts --judge <name> --out <folder>
```

The config's judge reads its key with `env('RETEST_EVALUATION_AZURE_KEY')` or another variable; the command reads no key from any file. Exit status 0 means both gates were met, 1 that one was not, 2 that the corpus could not be run.

## Rebuilding the captures

Browser evidence, under the heavy-gate lock since it starts real browsers:

```sh
lockf -t 0 /tmp/retest-heavy-gate.lock env RETEST_FIREFOX_ROUTE=launch-services node --conditions=retest-source fixtures/evaluation-corpus/capture/capture-browsers.ts
```

The script replaces `captures/screenshots`, `captures/text`, `captures/frames` and `captures/diagnostics`, and writes `captures/capture-browsers.json`. A rebuilt capture can differ in pixels, frame times and frame counts from the checked-in one, so after a rebuild every label is read again against the new evidence before the corpus is run. The native captures in `captures/native/` were made by Retest's own native proofs; `captures/native/sources.json` names the proof, the command and the original file of each.

The perfect fake uses a fixed answer script in `judges/fake-judges.ts`, separate from the labels scored. It does not inspect text or pixels. Its agreement tests the runner and arithmetic only. The founder settled the kinds and labels for `frames-toast-wrong`, `frames-injection`, `frames-spinner-early` and `shot-chrome-saving`. The first three are seen claims and inconclusive by rule; the snapshot is a state claim and an unambiguous failure. The other labels await founder review. No capture or requirement wording changed. The scorer also reports counts by declared criterion kind; a check with more than one kind counts once under each of its kinds.
