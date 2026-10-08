# Retest final testing and Rehearsal integration handoff

Continue in `/Users/dragon/Documents/Projects/Gruvi/Products/retest`. Finish testing and fixing the phase 1 through 4 implementation, then prepare phase 5, the Rehearsal integration. The implementation is saved in Git, but the final acceptance checks are unfinished. A checkpoint commit does not make the release complete.

## Read first

1. `AGENTS.md`, `README.md` and `docs/architecture.md`.
2. This handoff and `docs/plans/public-beta/release-0.1.0.md`. That release plan defines the five phases used here. The older `plan.md` and `docs/roadmap.md` use different phase or step numbering.
3. `docs/plans/public-beta/reviews/fix-reports/browser-leftovers-report.md` and `native-leftovers-report.md`. These are the latest testing records.
4. `docs/plans/public-beta/progress.md`, the phase 2 and 3 reviews, and the two phase 4 second-read reviews. Older progress entries retain historical blockers; use later reports and current code to settle their status.
5. `docs/plans/public-beta/codex/phase-4/criterion-kinds-report.md`, `native-withhold-off-report.md`, `licence-wording-report.md` and `measurements-report.md` for the final policy changes.

## Git and release state

- Retest is a separate repository beside Rehearsal. The previous session was attached to the Rehearsal directory, so set the Retest working directory explicitly before every command.
- Branch `main`. Phases 1 and 2 were already committed and pushed. Phase 1 ends at `30dda4a`; phase 2 ends at `b59eed5`.
- The founder authorized committing all remaining phase 1 through 4 work with this handoff. The signed checkpoint after `b59eed5` contains phase 3, phase 4, review fixes, fixtures, tests, reports and benchmark records. Check `git log`, signature status and `git status` before starting.
- That checkpoint is unpushed. Do not push, publish, tag, deploy or rewrite published history without a new instruction.
- `package.json` remains `private: true`, version `0.0.0`. No release candidate has been promoted.
- `pnpm-lock.yaml` is unrelated and remains untracked. Leave it alone. Retest uses npm and `package-lock.json`.
- The earlier date removals in `docs/roadmap.md` and `docs/plans/speed/handoff.md` are included. Their old release-state claims are historical.
- Rehearsal has extensive unrelated uncommitted work. Inspect and preserve it before integration. Nothing in this checkpoint changes that repository.

## What is built

| Phase | Implementation | Remaining acceptance work |
| --- | --- | --- |
| 1 | Session contract, locators and assertions, test controls and locks, TypeScript loading, evaluation adapter, diagnostics, replay and platform proofs | Preserve these guarantees through the final complete run |
| 2 | Electron, native iOS simulator and macOS sessions, resources, shared identity, native diagnostics and the cross-platform reference flow | Confirm the latest native fixes across the complete list |
| 3 | Firefox and WebKit drivers, conformance, pinned installation, agent sessions, scoped Playwright compatibility and engine diagnostics | Finish the stopped browser run, restore installer fixtures, retain explicit engine limitations |
| 4 | Rust media, capture on five targets, recording and privacy rules, HTML evidence report, frame evaluation, artifact policy and measurements | Finish all evidence and failure-path checks on the final source, validate live evaluators and corpus labels |
| 5 | Defined in the release plan | Rehearsal integration and clean-consumer release preparation follow finalization |

## Exact stop point

The founder stopped the browser lane, then the native lane. Their final reruns were interrupted. Do not resume an old queue or describe an interrupted run as passing. The previous session ended its test browsers, native runner and temporary simulator.

A later read-only process check still found an idle unit child, PID 36744, and a cross-platform fixture service, PID 86905. The measurement report explicitly leaves the idle child alone. Recheck current process identities and ownership before acting; these PIDs are historical observations, not permission to signal a process. Do not claim the machine is empty.

| Check | Latest completed evidence |
| --- | --- |
| Source typecheck | Both TypeScript compilers and the examples passed. Also rerun successfully during checkpoint preparation |
| Build | Passed during checkpoint preparation |
| Public type tests | 246 expected errors matched on each compiler in the native lane and in checkpoint preparation |
| Complete serial unit suite | 4,255 passed, 648 suites, zero failures or skips. `.retest/native-leftovers/logs/unit-suite-clean.log` |
| Default-concurrency unit suite | Retained failure, 4,251 passed and 4 failed. The same cases passed serially without edits; contention is an inference, not proof that the default gate is fixed |
| Earlier complete browser run | 1,663 tests, 1,654 passed, 6 failed, 3 live-provider skips. Later repairs and focused passes exist, but the final complete rerun was stopped |
| Browser conformance in the leftovers lane | 492 passed, zero failures or skips |
| Timeline repetitions | Repetitions 3, 4 and 5 each passed 5 outer checks and the 6-check flow child. All 20 original app checks appeared in their videos. Repetitions 1 and 2 remain failures |
| Complete native list before additional fixes | 100 tests, 87 passed, 13 failed, no skips. Additional capture fixes and focused checks followed; the final native rerun was stopped |
| Focused native checks after additional fixes | 145 related unit checks passed; native evaluation 3 of 3 and native evidence 6 of 6 have isolated passing runs |
| Rust on Linux and Mac | Later Linux media report records 103 Linux units, 104 Mac units and 57 process tests per host passing, with one Linux ffmpeg-absence skip. Both release builds passed; Mac Clippy passed; Linux Clippy remains unverified |

Logs and artifacts under `.retest/` and `/tmp/` are local, ignored evidence. The committed Markdown reports preserve commands and conclusions, but do not carry every raw artifact. Inspect what still exists before depending on it.

## Failures and prerequisites to resolve

- Three installer tests consistently fail because the original checksum-pinned archives were deleted after the pinning proof. Required files are in `~/Library/Caches/retest-proofs/downloads/`: `chromium-mac-arm64-chrome-mac-arm64.zip`, `firefox-mac-arm64-Firefox 133.0.3.dmg` and `webkit-mac-arm64-webkit-mac-26-arm64.zip`. Restore the exact bytes from the pinned sources or locate retained originals. Verify hashes. Do not substitute archives or turn failures into skips. The founder authorized these browser downloads earlier; the leftovers lane's no-download rule was its own narrower assignment.
- Native full-list failures included checked-window capture reply timeouts, simulator system banners and covering windows. The lane added bounded capture fixes and setup checks. Reproduce against the current source. Preserve the original predicates, budgets and privacy refusals.
- Since 9 October 2026 macOS captures take the app's own window by its number, so another application's overlapping window no longer refuses them, but a click still refuses while another window lies over the element's centre. Coordinate with the founder before desktop tests so TaskDesk is unobstructed, including by Wispr Flow. Never move or terminate a personal window automatically. Window layers 21, 23 and 1000 in earlier failures do not establish the same window identity.
- The three live evaluator gates require deliberately supplied Anthropic, OpenAI and Azure credentials. Do not obtain credentials from Rehearsal or personal files. Fake evaluators and the scripted corpus prove runner behavior, not model accuracy.
- The corpus has 45 cases, 4 reviewed labels and 41 awaiting founder review. Preserve that distinction before claiming an accuracy gate passes.
- Rebuild media after Rust changes and refresh the installer source digest using the documented generator. A stale binary or pin is not a product verdict.

## Decisions already settled

- Browser downloads are explicit and pinned. WebKit installation keeps the nine notice files and uses the concise installer wording. Check that the packed artifact contains them. Do not reinstate a wall of licence text at installation.
- Firefox console capture remains unavailable. The fresh probe showed that serialization of enumerable getters can execute page code before delivery. Network capture remains available. The refusal and reason must stay visible.
- HTML click-to-jump is implemented with one fixed script allowed by its content hash. Preserve escaping, the data-block rules and the script restriction.
- Native pixel withholding is off by default, by the founder's decision. Secure fields still require verified masked read-back. `recording.nativeWithholding: true` or `RETEST_NATIVE_WITHHOLDING=true` enables guarded withholding for ordinary native secret fields. Browser secret withholding remains enabled. Older reports describing native withholding as the default are superseded.
- Evaluation criteria explicitly declare `state`, `seen` or `never`. Missing frames cannot support a pass. A forbidden appearance needs a citation to a frame actually supplied. Do not infer criterion kind from prose or loosen the missing-frame rules.
- Process metadata uses a fixed time zone and identity checks before signals. Preserve fail-closed ownership behavior, cancellation uncertainty, required-check identity and parent-owned verdicts.

## Continue in this order

1. Confirm the checkout, Node, browsers, executors, media binary, installer archives and retained logs. Check for active work before launching anything. Record one current failure inventory.
2. Restore installer prerequisites. Run each unresolved browser or native file alone. Classify each failure with evidence as a product regression, a stale expectation after an approved behavior change, or a host/setup problem. Fix its cause without weakening a pass.
3. Run the complete browser and native lists sequentially on a quiet, unchanged tree. The retained lists are `.retest/clean-run/integration-browsers.list` and `integration-native.list`. If absent, reconstruct coverage from all current integration files; do not omit a gate to get green counts.
4. Complete the independent confirmation run: build, source and proof typechecks, public type tests, unit tests, complete integration coverage, Rust tests and Clippy, conformance, compatibility comparisons, replay/failure paths and clean packed-consumer checks. Record exit codes, counts, skips and evidence locations. Resolve the default-concurrency unit failures as well as the serial gate.
5. Read the existing recording measurements before adding a speed claim. They live in `benchmarks/results/measurements-phase-4/`. They predate later fixes. For a performance change, measure before and after through `npm run bench`, alone. Retain invalid samples and rows where Retest loses.
6. Once phase 1 through 4 acceptance checks are complete, prepare the pinned package and phase 5 Rehearsal work. Inspect `packages/retest-adapter`, `packages/codegen/src/retest`, `packages/browser/src/runtime.ts`, `apps/runner/src/host.ts`, Re:agent browser tools and the codifier in the sibling Rehearsal repository.
7. Exercise discovery, saved flow, codification, independent verification and ordinary execution through the runner. Connect live frames to the relay and finalized artifacts to evidence uploads. Preserve worker-owned credentials, runner isolation, permissions, stop behavior, attempt fencing and recovery. Prove passing, deliberately failing and interrupted flows.
8. Prepare the release receipt with the exact source revision and package digest, clean Mac/Linux consumer results, known gaps and promotion inputs. Commit later fixes only when asked. Publication, pushing and deployment need separate authorization.

## Commands and working rules

The login shell currently selects Node 20, which is unsupported. Select the installed Node 24.12 explicitly before running npm:

```sh
cd /Users/dragon/Documents/Projects/Gruvi/Products/retest
export PATH=/Users/dragon/.nvm/versions/node/v24.12.0/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
node --version
git status --short --branch
git log -5 --format='%h %G? %s'
npm run build
npm run typecheck
npm run typecheck:proofs
npm run test:types
npm run test:unit
node --conditions=retest-source --test --test-concurrency=1 'tests/unit/**/*.test.ts'
```

For real-target integration, the previous host needed these settings:

```sh
export RETEST_FIREFOX_ROUTE=launch-services
export RETEST_TEST_MEDIA_BINARY="$PWD/media/target/release/retest-media"
export RETEST_MEDIA_BINARY="$PWD/media/target/release/retest-media"
lockf -t 0 /tmp/retest-heavy-gate.lock npm run test:integration
```

Launch Services is a workaround for this host's Firefox data-access restriction. Keep ordinary spawn support. Check actual browser paths from the proof reports and current environment rather than inventing defaults. Use the Homebrew Rust toolchain documented in `evaluation-closeout-report.md`; older rustup tools can be selected accidentally.

Run one heavy job at a time. Native desktop and simulator jobs share the same lock. Never run any tests while a benchmark is running. Do not edit a source tree under a running gate. Audit only owned processes and leave unrelated applications and services alone.

Keep updates short, in plain bullets. Give the result first. No estimated dates or durations. Nothing may weaken required assertions or evidence. Keep a durable record of the latest finished check and the exact next command, then continue from it after compaction.
