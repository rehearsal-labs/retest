# Phase 4 second read: report, install and evaluation

Read-only review of the requested Phase 4 sources, their unit tests, the six lane reports, common invariants, evaluation proof and release requirements. The only repository file written by this reviewer is this report. No browser, simulator, app, media process, ffmpeg, benchmark, build, download or provider call was started. Unit tests used temporary fixtures, fake drivers and injected build functions.

There are three P1 findings, eight P2 findings and one P3 finding. Passing unit tests do not cover the confirmed failures below.

## Findings, most severe first

### 1. P1 — Code frames copy private files into the shareable report

**Files:** `src/reporters/html/failure-view.ts:122`, `src/reporters/code-frame.ts:38`, `src/reporters/html/build-report.ts:32`.

The boundary check is lexical: resolve a location under the recorded project directory and reject a relative path beginning with `..`. The subsequent `readFileSync` follows symlinks, reads the whole file without a byte bound and supplies its lines directly to HTML without secret redaction. There is no restriction to the test files that ran. A failure location naming `.env:1` is accepted; a project-local `linked.ts` pointing outside the project is accepted too. A FIFO at a selected location can block the synchronous read.

**Concrete failure:** a test reports a failure at `linked.ts:1`, where that file points to a private file outside the project. Its contents enter the report even though events contain only redacted text. A process-free fixture put a synthetic secret outside the project, omitted it entirely from the events, and confirmed that the complete HTML report contained it. A separate `.env` fixture was also shown.

**Confidence:** high; reproduced through the full report builder. The HTML safety test's secret fixture does not cover this source-reading path. The safe, bounded artifact reader is bypassed. Source display needs an approved, bounded source policy or a redacted source snapshot, rather than arbitrary location-driven reads.

### 2. P1 — Diagnostics rejected by the safe reader still have clickable links

**Files:** `src/reporters/html/diagnostics-view.ts:72`, `src/reporters/html/diagnostics-view.ts:82`, `src/reporters/html/artifact-files.ts:97`.

The artifact link is built before the diagnostics file is read. `files.link()` checks portable path syntax only. Refusing the read does not remove the link.

**Concrete failure:** an event names `diagnostics/leak.jsonl`, which is a symlink to a private file outside the run folder. The report says the file was refused but still emits `href="diagnostics/leak.jsonl"`. Following that link accesses the external file. An outside hard link behaves the same way. A syntactically valid reference to a private `states/` file can also receive a link, despite not being an approved diagnostics artifact.

**Confidence:** high; synthetic symlink and hard-link fixtures both produced a refusal and a clickable href. No browser was opened. Traversal escaping works, but escaping a path does not establish its ownership. Links must depend on the same successful ownership/read decision as displayed evidence.

### 3. P1 — Retention can unlink outside the run folder after its final check

**Files:** `src/store/artifacts.ts:803`, `src/store/artifacts.ts:817`.

Retention verifies the checked file, then calls `unlinkSync` with its absolute pathname. The unlink does not operate relative to a retained directory handle. A directory can be replaced between verification and pathname resolution by the unlink.

**Concrete failure:** after verification, another writer renames `artifacts/session/` and replaces it with a symlink to an outside directory containing `recording.mp4`. Retention deletes the outside file, leaves the original recording in the renamed directory and reports a successful removal of the intended recording.

**Confidence:** high; a scoped filesystem hook simulated exactly this interleaving using synthetic directories. The outside fixture was deleted, the intended recording remained and `outcome.removed` claimed success. This establishes the race, not its probability on an ordinary run. The existing swap tests intervene before verification and miss this boundary.

### 4. P2 — Partial frame evidence is labelled complete; frame and diagnostics evidence are rendered as screenshots

**Files:** `src/reporters/html/evidence-status.ts:85`, `src/reporters/html/evaluations-view.ts:61`, `src/store/artifacts.ts:511`, `src/store/artifacts.ts:537`.

The evidence-status loop handles only screenshot evaluation evidence. It ignores frame/diagnostics `status`, omissions, reasons, unplaced frames and nested frame files. The renderer treats every non-text item as a screenshot: frames usually have no top-level path and are reported as an unsaved screenshot; diagnostics JSON is passed to the picture reader. Artifact reference extraction skips nested `frames[].path` and classifies diagnostic evaluation files as screenshots. Criterion rows also omit `judgeVerdict` and the parent's rule.

**Concrete failure:** a failed test has a kept failure screenshot and an advisory inconclusive frame evaluation whose event says `status: partial`, names an omission and references a missing saved frame. The report and its outcome JSON say `Evidence complete`; the omission is absent and the frame evidence is called an unsaved screenshot. Saved frame images are instead listed as unreferenced, and missing ones escape the named-artifact inventory.

**Confidence:** high; reproduced in the full report and JSON block. No corrupt child verdict was needed. Production gathering correctly records partial evidence, but the report loses those fields. The same branch omissions affect diagnostics evidence. The report agreement tests do not cover these new kinds.

### 5. P2 — Full media verification accepts a binary replaced after hashing

**Files:** `src/cli/install/media-record.ts:95`, `src/cli/install/media-record.ts:99`, `src/shared/regular-file.ts:122`, `src/media/locate.ts:50`.

The hash reader checks the descriptor's identity when opening it, but returns only a digest. Inspection then checks the pathname's current mode and regular-file status without comparing its identity to the hashed file. Discovery subsequently returns the pathname for execution.

**Concrete failure:** replace the binary with another regular executable after the original descriptor was hashed but before inspection's later `lstat`. Full `verify: true` returns `installed`, even though the executable now at that path does not match the recorded digest. Replacing it after discovery introduces another check-to-execution gap.

**Confidence:** high for the inspection bug; a deterministic filesystem hook reproduced it with synthetic executables, without launching either. The returned record's digest differed from the current binary's digest. The existing damaged-cache tests change files before inspection, not during it. Verification needs to bind its identity and bytes to what will actually be used.

### 6. P2 — Judge-key variables reach media and encoder helpers

**Files:** `src/runner/run-session.ts:403`, `src/runner/run-media.ts:43`, `src/media/client.ts:399`; downstream `media/src/encoder.rs:215`.

The runner removes judge variables from test-file processes, browsers, native pools and app servers, but does not pass that exclusion to media startup. `MediaProcess.start` spawns with no environment override, so it inherits the parent's environment. Rust's ffmpeg spawn likewise inherits its environment.

**Concrete failure:** a recording run declares an environment-backed judge credential. The media executable, and then the selected ffmpeg executable, receive that key despite having no role in judging. An explicit developer binary or substituted executable accepted through finding 5 can read it.

**Confidence:** high for inheritance. An in-memory spawn hook confirmed that startup passes no environment override while a synthetic judge-key variable exists; it threw before any process could start. Downstream ffmpeg inheritance was checked statically. This is an additional helper-process credential path; I found no new direct leak to the test process, app server or browser in the reviewed environment-filtering paths.

### 7. P2 — Retention's records can claim a removal that never happened, or allow deletion without a record

**Files:** `src/store/artifacts.ts:798`, `src/store/artifacts.ts:803`, `src/store/artifacts.ts:498`, `src/store/rebuild-result.ts:264`, `src/runner/run-session.ts:1513`, `src/runner/event-log.ts:99`.

Two related failure boundaries break the removal contract.

First, `artifact.removed` means intent: it is written before verification and unlink. If Retest dies before unlink, reconstruction treats the recording as removed, excludes its reference and the report says retention removed it. A later `artifact.removal_failed` can correct an ordinary error, but cannot correct a crash that prevented that event.

Second, the actual runner recorder calls `EventLog.emit`. A failed store append is caught inside the log and does not throw to `applyRetention`. Retention therefore deletes the file even though its removal could not be persisted. Its documented “a removing that throws keeps the file” protection does not apply to this wiring.

**Concrete failure:** a storage write fails on the removal event; the real event-log path records a reporting failure but returns normally, and retention deletes the recording with no persisted removal. Separately, an interrupted removal leaves the file present while event reconstruction excludes it.

**Confidence:** high. The failed-append case was reproduced with the actual `EventLog` and synthetic store/file. A recorder that recorded then threw reproduced the present-file/excluded-reference discrepancy; the crash boundary follows directly from the operation order. Use explicit intent/completion semantics and a persistence success result before deletion.

### 8. P2 — A thumbnail shared with a retained recording is planned for deletion

**File:** `src/store/artifacts.ts:716`.

A thumbnail is eligible when any reference associates it with a recording being removed. The protection checks only non-thumbnail references or evaluation ownership; another thumbnail reference belonging to a different attempt or a retained recording does not protect it.

**Concrete failure:** passed attempt A's recording and failed attempt B's recording share a thumbnail path. With failure-only retention, the planner keeps B's recording but removes their thumbnail.

**Confidence:** high at the planner boundary; reproduced with valid reference objects and an actual temporary-file inventory. The current runner does not emit this shared-thumbnail arrangement, so this is a planner contract defect rather than a demonstrated ordinary capture failure. Apply the same multiple-owner protection used for recordings.

### 9. P2 — Runner media startup omits install/doctor greeting identity checks

**Files:** `src/media/locate.ts:58`, `src/runner/run-media.ts:48`, `src/runner/run-media.ts:157`, `src/runner/run-media.ts:182`; compare `src/cli/install/media-tools.ts:78`.

Discovery deliberately avoids a second media process. The eventual live start checks protocol framing and encoder readiness, but never enforces media version, host target or release profile. Install and doctor enforce all three.

**Concrete failure:** `RETEST_MEDIA_BINARY` names a protocol-2 executable reporting version `99.99.99`, another target and a debug build. Its encoder says ready. The runner accepts it and emits `media.started`; a probe through install/doctor would reject it.

**Confidence:** high; an in-memory `FakeMedia` with those greeting fields was acquired successfully. No media binary ran. Keeping a single start is sound, but its actual greeting must receive the same identity checks.

### 10. P2 — Media hashing has no byte bound or cancellation/deadline

**Files:** `src/shared/regular-file.ts:117`, `src/cli/install/media-record.ts:51`, `src/cli/install/media-record.ts:95`, `src/media/locate.ts:50`.

The hashing loop reads until EOF without enforcing a maximum size, a fixed initial size, a deadline or a signal. `inspectMedia` describes these as bounded regular-file readers, but only record-text reads and the binary-copy path have byte bounds. Discovery's timeout does not bound inspection.

**Concrete failure:** a damaged cache binary or pinned-source file is replaced with a very large sparse file. Install verification, doctor or discovery reads it fully before detecting the wrong digest. A file continually extended ahead of the reader can prevent EOF; runner shutdown awaits discovery rather than cancelling this hash.

**Confidence:** high from the loop and call paths. Deliberately unbounded reads were not executed. A fixed byte limit and a cancellation/deadline policy need to apply before and during hashing.

### 11. P2 — Three corpus labels conflict with the written requirements or rubric

**Files:** `fixtures/evaluation-corpus/cases.json:919`, `fixtures/evaluation-corpus/cases.json:930`, `fixtures/evaluation-corpus/cases.json:1130`, `fixtures/evaluation-corpus/cases.json:1141`, `fixtures/evaluation-corpus/cases.json:176`; rubric `fixtures/evaluation-corpus/README.md:21`; scoring `fixtures/evaluation-corpus/runner/score.ts:117`.

| Case | Current label | Problem and correction needed |
| --- | --- | --- |
| `frames-toast-wrong` | unambiguous fail | The requirement is existential: a correctly worded notification appears somewhere in the interval. A seen wrong-title notification does not contradict that existence. With this wording, inconclusive is warranted; alternatively explicitly require the particular observed notification's title to be correct. |
| `frames-injection` | unambiguous fail | Seeing “Save failed” does not prove a correct saved notification never appeared between samples. The same requirement correction or inconclusive label is needed. Ignoring the injection remains required in either case. |
| `shot-chrome-saving` | fail, ambiguous | The screenshot plainly reads “Saving…” where the requirement asks for the exact saved title. Fail is sound; `unambiguous: false` conflicts with the snapshot requirement and excludes this clear failure from the 90% denominator. |

**Concrete failure:** a careful judge returns inconclusive for either existential frame case and the scorer counts it wrong, rewarding the scripted fail instead. The saving screenshot's ambiguity flag makes the conclusive denominator easier without an evidence ambiguity.

**Confidence:** high for the literal wording/rubric mismatch and saving screenshot flag; the two frame verdicts depend on resolving the intended meaning. I inspected the decisive retained pixels as well as their manifests. The lane report already identifies these doubts, but the current labels still encode them. No labels were changed. `frames-flash-absence`'s corrected fail is sound because a saved frame shows the forbidden banner; `frames-spinner-early`'s inconclusive remains consistent with temporal appearance. No other label error was identified in the 45-case read.

### 12. P3 — The guide and proof contain stale present-tense Phase 4 limitations

**Files:** `docs/guide.md:1909`, `docs/guide.md:1911`, `docs/guide.md:1912`, `docs/plans/public-beta/proofs/evaluation.md:334`, `docs/plans/public-beta/proofs/evaluation.md:366`.

The guide still says there is no video, no HTML report and that recording-frame evidence is refused. The evaluation proof says default secret-aware screenshot policy and diagnostics runner wiring are absent; the current constructor and snapshot wiring implement them, and the selected unit tests exercise them. Earlier lane reports also retain historical, explicitly pending handovers.

**Concrete failure:** a user follows the current limitations section and concludes that implemented report/frame APIs are unavailable, or treats the old wiring gap as the current code state. Conversely, none of the recorded fake-corpus success should be read as a model accuracy gate.

**Confidence:** high for contradictions with current source and unit coverage. Real-target verification remains separate. Update the current capability section while keeping historical reports identifiable as history.

## What I checked and found sound

- **Escaping and passive report structure:** inspected all HTML modules and the report command. Strings flow through the markup builder; text/quoted attributes escape metacharacters, and the JSON data block escapes script-ending characters. Recorded URLs are displayed as text in the report. No raw interpolation of a test title, console line, URL, error, filename or recording gap into executable markup was found. The generated document has fixed CSS, no executable script, no remote resource URL and a restrictive CSP. This is a source/unit conclusion, not a new browser network observation. Findings 1 and 2 are independent file-access/link failures.
- **Artifact reads and paths:** portable references reject traversal, absolute paths, schemes, backslashes and unsafe segments. Reads require caller-supplied byte bounds, reject symlinks and hard links, compare descriptor identity, recheck parent directories and refuse size changes. Screenshot/video report reads use the checked descriptor for a small header. Those tests passed; they do not establish that a path stays safe when a browser reopens it later, nor that a magic header proves decodability.
- **Pixel policy:** app rules, withheld secret-entry stretches, delayed-span overlap, cross-session window-crop withholding and explicit reasons are implemented and exercised by the selected tests. Unknown field facts are treated conservatively in runner secret-entry wiring. I did not find a new demonstrated pixel-policy bypass in this read. No real pixel-redaction claim follows from those tests.
- **Install/discovery outside the findings:** source files, lock and licence notices are pinned; the source build requests release plus `--locked` and checks copied source before/after the injected build. Damaged caches and aliases into them are refused; unpinned prebuilt requests refuse before reading or requesting the binary. The generation lock test, source-mutation test, record limits, mode checks, notice checks and missing-tool doctor rows passed. Discovery does not search Cargo target directories or install automatically.
- **Rust minimum:** `media/Cargo.toml` declares Rust 1.88. All 32 locked registry-crate manifests were available locally and read; the highest declared minimum is `image 0.25.10` at 1.88.0. The distinction between Edition 2024's 1.85 minimum and this crate's 1.88 requirement is accurate. This verifies metadata, not a build with Rust 1.88.
- **Parent verdicts and precedence:** inspected `withEvaluationFailures`, attempt completion and the API/protocol path. A child's claimed evaluation outcome is not authoritative. Parent failures lead over inconclusive results, then errors; a later answer cannot clear an earlier failure. Race/forgery unit checks passed.
- **Missing-frame settlement:** pass over known missing frames becomes inconclusive; a must-appear failure becomes inconclusive; an absence failure stands only when it cites a frame actually sent. Absence passes are inconclusive even on complete samples. The parent preserves original judge verdicts and its rule. This validates settlement and citation membership, not whether a real model's cited pixels semantically prove its claim.
- **Frames, budgets and late replies:** gathering checks interval, order, identities, accounting, bounds, byte lengths and signatures. Pending/unprocessed frames are omitted from judge images and recorded as missing; undecodable/out-of-range losses are represented. No-frame/refused evidence avoids a judge call. Call reservations are synchronous across attempt/run budgets, slots are bounded and released, and late replies are discarded. Selected unit checks passed.
- **Diagnostics and credentials before judging:** snapshots clone/freeze nested data without closing collection or spending its bounds; unavailable and native-no-live-snapshot states stay explicit. Selection rejects foreign record identities, bounds newest selected records and redacts again before saving/sending exact diagnostic text. Callback credentials are resolved before evidence freezing; callback failures use a generic message. The selected snapshot, secret-policy and race tests passed.
- **Corpus arithmetic and fakes:** the scorer validates the complete case/repeat matrix and rejects unknown, missing, duplicate and invalid repeats. Inconclusive/error answers do not count as correct in the conclusive gate; a critical case passing any repeat fails its gate. The perfect fake's fixed case-id script is independent of the labels, and a mutation test checks that changing a label does not change its answer. It still passes the existing cases by scripted construction and reads no pixels. Negative fakes exercise failure, disagreement and provider error. Current corpus documentation accurately limits this to arithmetic/lifecycle proof; all 45 labels await founder review.

### Checks actually run

Node was `v24.12.0`. These commands ran sequential unit files and returned exit 0:

```sh
node --conditions=retest-source --test --test-concurrency=1 \
  tests/unit/store-artifacts.test.ts \
  tests/unit/store-retention.test.ts \
  tests/unit/media-policy.test.ts \
  tests/unit/reporters-html.test.ts \
  tests/unit/reporters-html-safety.test.ts \
  tests/unit/reporters-html-agreement.test.ts \
  tests/unit/reporters-html-command.test.ts \
  tests/unit/reporters-html-escape.test.ts \
  tests/unit/evaluation-frames.test.ts \
  tests/unit/evaluation-frame-store.test.ts \
  tests/unit/evaluation-diagnostics-view.test.ts \
  tests/unit/evaluation-races.test.ts \
  tests/unit/evaluation-evidence-api.test.ts \
  tests/unit/evaluation-corpus-cases.test.ts \
  tests/unit/evaluation-corpus-run.test.ts \
  tests/unit/evaluation-corpus-score.test.ts \
  tests/unit/evaluation-secret-policy.test.ts

node --conditions=retest-source --test --test-concurrency=1 \
  tests/unit/media-install.test.ts tests/unit/media-locate.test.ts
```

Results: **250/250** in the first command and **17/17** in the second; **267 selected unit tests passed**, zero failed, cancelled or skipped. Media install/discovery tests were read before execution; their successful paths here do not launch a media executable or ffmpeg.

Two scoped strict compiler checks returned exit 0, using TypeScript **6.0.3** and **7.0.2**. Exact command roots:

```text
src/store/artifacts.ts src/media/policy.ts src/reporters/html/*.ts src/cli/commands/report.ts src/cli/install/media-*.ts src/media/locate.ts src/cli/doctor/checks.ts src/evaluation/*.ts src/api/evaluate.ts src/protocol/evaluation.ts src/diagnostics/attempt.ts src/diagnostics/session-capture.ts fixtures/evaluation-corpus/runner/*.ts fixtures/evaluation-corpus/judges/*.ts
```

Each used `node node_modules/typescript/bin/tsc` or `node node_modules/typescript-7/bin/tsc`, followed by these flags and the roots above:

```text
--ignoreConfig --noEmit --target es2024 --lib es2024 --module nodenext --types node --customConditions retest-source --strict --declaration --isolatedDeclarations --erasableSyntaxOnly --verbatimModuleSyntax --allowImportingTsExtensions --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters --skipLibCheck false
```

Six successful inline `node --conditions=retest-source --input-type=module -e` unit probes used production functions with synthetic fixtures or in-memory hooks:

1. Full-report source-secret leak; rejected diagnostics links; partial evidence status/reference omission; shared-thumbnail planning; pre-recorded removal discrepancy.
2. Wrong media greeting accepted by an in-memory stand-in.
3. Actual event-log append failure allowing deletion; binary substitution accepted by full verification.
4. Spawn interception proving inherited environment, throwing before spawn.
5. Directory replacement between verification and unlink, proving outside-file deletion.
6. Full-report and JSON evidence status for a failed test with an advisory partial-frame event.

All six exited 0 and cleaned up their temporary files/hooks. An initial unlink probe failed because its hook matched the noncanonical temporary path while the reader used its canonical alias; matching the canonical path made the same assertions pass. An initial compiler invocation stopped at TS5112 before checking; the corrected `--ignoreConfig` commands above passed. These preparatory failures are not source test failures.

I also read README/architecture, the requested reports/invariants and relevant callers/tests; read all 45 case definitions, text/diagnostics fixtures, frame manifests and fake scripts; visually inspected all 12 browser screenshots, four native screenshots and decisive frames from all five frame scenes. Retained capture inspection is not a new target run. No mutation of production source or tests was used.

## What I could not verify

- Actual report rendering, browser parsing, link-following or network requests. In particular, generation-time checks cannot prove that a mutable artifact pathname remains safe when a browser later opens it. The symlink/hard-link diagnostics finding is established from the emitted link and filesystem ownership, without opening it.
- Real media install/build/probe/encoder cleanup, played or independently decoded recordings, real frame-store fates, target capture or native diagnostics. I did not execute Rust, ffmpeg, any browser/simulator/app or any media binary. Probe cleanup ownership paths were read, not exercised here.
- Compilation with the declared minimum Rust toolchain, a clean host, packaging, Linux x64 or other OS/architecture claims. The two scoped TypeScript checks are not whole-tree or published-consumer checks.
- Real judge accuracy, prompt-injection resistance, SDK/provider image transport or live credentials. Fake judgments establish no model quality, and the label issues above remain unresolved.
- A full CLI recorded-step frame evaluation, process exit-status/timeout lifecycle beyond the selected unit fixtures, or the real-target results claimed by builders' historical reports. Those results were not independently rerun. No benchmark or speed claim was made.
- The pre-test inventory command `pgrep -f 'benchmarks/[r]un.ts'` could not read the process list: the tool reported that sysmon/sysmond was unavailable. I started no benchmark and did not signal another process.

Concurrent-tree handling: hashes were recorded and compared across the review. **No scoped source, selected test, corpus file or requested reference document changed during the checks.** `tests/unit/native-processes.test.ts` changed outside this scope and was excluded. Two builder-created files, `docs/plans/public-beta/codex/phase-4/evidence-targets-state.md` and `evidence-targets-report.md`, appeared during review and were excluded. These are concurrent-builder work, not reviewer edits.
