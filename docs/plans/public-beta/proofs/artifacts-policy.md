# Artifact paths, safe reads, retention and the pixel capture policy: lane record

5 October 2026. Release 0.1.0, Phase 4 item 5 of [release-0.1.0.md](../release-0.1.0.md): "the pixel capture/redaction policy, artifact retention, path ownership and safe reads". Brief: `docs/plans/public-beta/codex/phase-4/artifacts-policy.md`. This lane builds modules and their documentation; the recording-runner lane wires them into the runner and the config, so nothing here changes what a run does yet.

## Result

- `src/store/artifacts.ts`: one function for every artifact's path, portable references and their checks, a safe read that refuses by name anything that would leave the run folder, a listing of a run folder against its records, and retention with a planner and an executor that records each removal before the file goes.
- `src/media/policy.ts`: the pixel capture policy as types and one per-run class: per-app rules, a decision from what the driver read of the field a secret is typed into, withheld stretches with their records, and the overlap rule that decides each capture.
- `src/reporters/html/escape.ts`: `escapeHtml` for text and quoted attributes, `pageHref` and `artifactHref` for links, `scriptJson` for data in a non-running script element.
- The guide's sections "Artifacts" and "What may be captured as pixels" (`docs/guide.md`).
- 66 unit tests in four new files, every safe-read refusal shown against real symbolic links, hard links, pipes and swaps in a temporary folder.

## Files

| File | What it is |
| --- | --- |
| `src/store/artifacts.ts` | Paths, references, safe reads, listing, retention |
| `src/media/policy.ts` | The pixel capture policy |
| `src/reporters/html/escape.ts` | HTML escaping for the report |
| `tests/unit/store-artifacts.test.ts` | 30 tests: paths, references, folder creation, safe reads, swaps, listing |
| `tests/unit/store-retention.test.ts` | 11 tests: plans and their application, with swaps |
| `tests/unit/media-policy.test.ts` | 15 tests: rules, masking, stretches, overlap, shared display |
| `tests/unit/reporters-html-escape.test.ts` | 10 tests from hostile strings |
| `docs/guide.md` | Two new sections before "Use Retest from code"; nothing else in the guide changed |

No dependency, script or environment change. Nothing outside these files was edited.

## How to run it

```sh
node --conditions=retest-source --test tests/unit/store-artifacts.test.ts tests/unit/store-retention.test.ts tests/unit/media-policy.test.ts tests/unit/reporters-html-escape.test.ts
```

## Artifact paths

`artifactPath(spec)` gives every artifact's path relative to the run folder:

```text
artifacts/<attempt>/<app>/screenshot-<failure|evaluation>-<n>.<png|jpg>
artifacts/<attempt>/<app>/thumbnail-screenshot-<purpose>-<n>.<png|jpg>, thumbnail-recording-<n>.<png|jpg>
artifacts/<attempt>/<app>/recording-<n>.<mp4|webm>        (recordingOutput gives the stem for the media process)
artifacts/<attempt>/<app>/frames-<n>/<index, six digits>.<png|jpg>
diagnostics/<attempt>.<app>.jsonl
report.html
```

- A name is made only of the attempt id (a slug with a hash when it is not Retest's own `[a-z0-9]{1,40}`), a slug of the app's name with a hash of the whole name, the kind, a closed purpose, and numbers. The test id and the look id never reach a name; neither does page text or a secret. A test of a hostile identity (`../../etc/passwd <script>`, an attempt id with `/../`, an app named `../../Home Screen`) shows every name is a portable reference holding none of it.
- The app is always slugged, so `Web` and `web` get different folders on a case-insensitive disk.
- Diagnostics stay flat in `diagnostics/`, because `RunStore.redactDiagnostics` rewrites only the files directly in that folder; moving them would leave a late-learned secret unredacted there.
- The identity's `sessionId` must equal `formatSessionId(attemptId, app)`, or `artifactPath` throws, so one session's artifact cannot be filed under another's folder. A purpose, format, container, sequence or index outside the listed values throws too, even when a caller casts past the types.
- `ArtifactSequences` hands out numbers per session and family from 1.
- The report is `report.html` at the top of the run folder, so its links to artifacts are the references themselves.

## References and safe reads

A portable reference is a POSIX path relative to the run folder, at most 1024 characters, in parts of letters, digits, `.`, `_` and `-`, none empty and none starting with `.`. That refuses `..`, `.`, absolute paths, backslashes, drives and schemes (`:`), percent signs, spaces, control characters and non-ASCII letters, without touching the disk. Every artifact path Retest has written before (`failureScreenshotFile`, `diagnosticsFile`, `evaluationScreenshotFile`) is one.

`portableReference` turns an absolute path, such as the media process's `ended.path`, into a reference, comparing real paths of the deepest existing folder on both sides (a run folder under `/var/folders` is `/private/var/folders` once resolved), and refuses a path outside the run folder or under a linked folder that leads out of it. `createArtifactFolder` makes the folders of an artifact one at a time, refuses a link or a file in the way, and reads the whole chain again at the end.

`readArtifactFile(runFolder, reference, { maxBytes })`, or `checkArtifact` then `open` then `read` for a caller that streams:

1. The reference is checked; the run folder is resolved to its real path once.
2. Each part below it is read with `lstat` (bigint device and inode), never followed. A symbolic link anywhere is refused: `outside_run_folder` when it leads out (worked out from the link text, which is never quoted in the message), `symbolic_link` when it stays inside. A part that is not a folder is `missing`. The last part must be a regular file (`not_regular_file` names a folder, pipe, socket or device), with one name (`hard_link`), no larger than `maxBytes` (`too_large`).
3. `open` uses `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`: a link swapped in at the last part fails with `ELOOP` (`changed`), and a pipe swapped in opens without waiting for a writer and is refused by `fstat`.
4. `fstat` on the descriptor must give the device and inode that were checked, one name and a size within the limit.
5. Every folder from the run folder down is read again and must be the same folder and not a link, and the file's name must still lead to the checked inode.
6. `read` reads exactly the checked size and refuses a file that became shorter or longer (`changed`).

`maxBytes` has no default; a non-integer, negative or infinite value throws.

### The gap that remains

Node has no `openat`, and macOS no way to ask a descriptor for its path (`realpath` of `/dev/fd/N` gives `/dev/fd/f.txt`; `readlink` gives `EINVAL`; probed on this machine). A process that flips a folder between a link and the real folder three times, each flip landing between particular steps above, could still have a file read through the link. Such a process runs as the same user. What was measured, not proved: `/tmp/retest-artifacts-probe/hammer.ts` runs `swapper.mjs` in a second process, which swaps `artifacts/k3` for a link to an outside folder holding a file of the same name and back as fast as it can, while the first process reads in a loop.

| Run | Reads | Swap round trips | Inside content | Outside content | Refusals |
| --- | --- | --- | --- | --- | --- |
| 5 s (`hammer-1.log`) | 188,000 | 25,408 | 25,914 | 0 | missing 94,957, outside_run_folder 44,206, changed 22,923 |
| 30 s (`hammer-2.log`) | 1,044,400 | 143,883 | 144,595 | 0 | missing 541,601, outside_run_folder 232,666, changed 125,538 |

Measured by this lane's first worker. Its logs and probe scripts were in `/tmp/retest-artifacts-probe/`, which did not survive the Mac's restart; the probe was not run again. Single-machine measurements; they show the race was not hit, not that it cannot be.

## The listing

`eventArtifactReferences(events)` reads `evidence.captured`, `diagnostics.finished` and each `evaluation.finished` evidence record with a path (marked `evidenceOf: 'evaluation'`); `resultArtifactReferences(result)` reads each test's `evidence`, `diagnostics` and evaluation evidence. `inventoryArtifacts(runFolder, references)` walks the folder without following links (at most 100,000 entries and 16 levels, `truncated` when it stopped) and returns `present`, `missing` (with the safe read's reason), `unreferenced` (with `partial` for `.partial` names) and `refused` (links, special files, files with a second name). The run's own files are left out: `events.jsonl`, `result.json`, `result.json.partial`, `report.html`, `logs/`, `states/`.

An event type added later names nothing until it is added to `eventArtifactReferences`.

## Retention

Rules: `{ recordings: 'all' | 'failures' }`, default `all`. Moments: `attempt_finished` (after `test.finished` and after every recording of the attempt ended or was lost, with the attempt's status) and `run_finished` (after the media process closed, before `run.finished` and `result.json`).

`planRetention` removes only, and only inside `artifacts/`:

- at `attempt_finished` with status `passed` under `failures`: each recording the attempt's records name, unless an AI check's evidence names it, another attempt's record names it, a record of another kind names it, or the listing did not find it present; then each thumbnail whose `of` is a removed recording and that nothing else names;
- at `run_finished`: each `.partial` under `artifacts/` that no record names.

Every recording of an attempt that did not pass (`failed`, `error`, `inconclusive`, `not_run`, `skipped`) is kept. Screenshots, frames, diagnostics, the report, logs and the run's files are never planned. `plan.kept` says why each considered file stayed.

`applyRetention(runFolder, plan, { removing, failed })` refuses a removal outside `artifacts/` or a recording planned as a partial (`not_removable`), checks each file as a safe read does, calls `removing(record)` (the runner writes the event), checks the file and its folders again, and only then unlinks. A `removing` that throws keeps the file (`unrecorded`). A check that fails after the record, or an unlink that fails, calls `failed(record)` and keeps the file.

### Proposed events (for `src/protocol/**`, not edited here)

| Event | Fields besides the envelope | When |
| --- | --- | --- |
| `artifact.removed` | `path`, `kind` (an artifact kind or `partial`), `reason` (`passed_attempt_recording`, `thumbnail_of_removed`, `lost_recording_partial`), `moment` (`attempt_finished`, `run_finished`), `bytes`, and `testId`, `attemptId`, `session` (the app), `sessionId` when the record knew them | Written before the file is unlinked, so no event ever names as present a file that is gone |
| `artifact.removal_failed` | the same without `bytes`, and `message` | A removal already written did not happen; the file counts as present again |

A reader decides a file is present when a record names it and its latest retention event is not `artifact.removed`, or is followed by `artifact.removal_failed`. `rebuildResult` and the result writer must leave a removed recording out of a test's evidence. The types are `ArtifactRemovedRecord` and `ArtifactRemovalFailedRecord` in `src/store/artifacts.ts`. `schemaVersion` stays 1; a reader built before these events refuses a folder that has one, since version 1 refuses unknown event types (reasoned from the schema, not run).

## The pixel capture policy

### Rules per app

`AppPixelRules { screenshots, recordings }`, each `allowed` or `never`, default both allowed (`defaultAppPixelRules`, `appPixelRules(input)`, `appPixelRulesSchema` for the config). `screenshots` covers the uses `failure`, `evaluation` and `agent`; `recordings` covers `recording` and `live`. Allowing recordings does not turn recording on.

### Masking, from what the driver reads

`fieldMasking(fact)`:

| Field the driver read | Decision |
| --- | --- |
| web `<input>` whose `type` property is `password` (any case), Chromium, Firefox, WebKit | masks |
| macOS `SecureTextField` | masks |
| iOS `SecureTextField` | `typed_characters`: can show the character just typed, and the keyboard the key pressed |
| any other input type (including `password ` with a space, which the property would never read), textarea, contenteditable, other, any other native type | `text` |
| unread | `unknown`, treated as showing |

A style such as `-webkit-text-security` never counts. The `type` property, unlike the attribute, reads `text` for an unknown type.

### Stretches and the overlap rule

`PixelCapturePolicy` is built once per run with `rules(app)`, the run's clock in microseconds and a `record` callback.

- `beginSecretEntry({ identity, secret, field, fact })`, called just before the first key: a field that does not mask opens a stretch at that moment (`capture.withheld`); a masking field records `capture.masked_entry` and capture goes on.
- `endSecretEntry(entry, { fact, input })`: `not_sent` closes the stretch (`nothing_typed`); `sent` or `unknown` keeps it. A masked field that no longer masks opens a stretch now with `cause: 'unmasked_while_typed'` and `exposedFromUs`, the moment the first key went.
- `fieldChanged(identity, field, 'gone' | 'empty' | 'masked')` closes that field's stretches in the session; `pageLeft(identity, 'new_document' | 'session_ended')` closes every stretch of the session (`capture.resumed`). A same-document navigation is not leaving.
- `decide({ identity, use, source, span? })`: the app's rules first (`app_rules`); then a capture is withheld (`secret_entry`) when its span, from when it was asked for to when it arrived, touches a stretch of its session: `fromUs <= arrivedUs` and the stretch is open or `untilUs > earliestUs`. Without a span the decision is for a capture asked for now. A screencast frame's `earliestUs` is when the screencast last started, so after a stretch its frames are kept only once the screencast is started again; a screenshot loop gives each tick's request time.
- `window-crop` captures are withheld while any session of the run has an open or overlapping stretch, since the macOS crop shows what lies behind rounded corners and translucent parts (`src/native/macos-app.ts` already refuses a capture with another window over the app's).
- `stretches()` returns frozen copies with counts of withheld screenshots and frames.

Records (proposed events, types `PixelPolicyRecord`): `capture.withheld` (`secret` name, `cause`, `fromUs`, `exposedFromUs?`), `capture.resumed` (`endedBy`, `fromUs`, `untilUs`), `capture.masked_entry` (`atUs`), each with `testId`, `attemptId`, `session` and `sessionId`. Microseconds are the run's clock, the unit frames are stamped in; the event's own `elapsedMs` is the moment the runner wrote it. A reader of an interrupted run sees a `capture.withheld` without its `capture.resumed` and must read the stretch as lasting to the end.

### What it cannot protect

Written in the guide: a secret the app shows on its own (echoed later, a message, a field revealed by a "show password" button whoever presses it); an app that unmasks a field while keys are typed, before the read after the last key; text shown before Retest knew it was a secret; live frames already sent before a field was read as unmasked.

## HTML escaping

- `escapeHtml` escapes `& < > " '` and the backtick, and turns NUL and lone surrogates into U+FFFD. Its doc comment names where app text is never safe, escaped or not: unquoted attributes, event handler attributes, `style`, inside `<script>` or `<style>`; and asks for `dir="auto"` around text, since direction controls are kept.
- `pageHref` returns a link only for `http:` and `https:` after WHATWG parsing (so `java\tscript:` and ` javascript:` are refused), drops a user name and password, and escapes the result.
- `artifactHref` returns a link only for a portable reference, each part percent-encoded.
- `scriptJson` writes `<`, `>`, `&`, U+2028 and U+2029 as JSON escapes for `<script type="application/json">`.

Tests: 16 hostile strings (markup, attribute breakouts with both quotes and the backtick, entities, comments, CDATA, `</script>`, NUL, lone surrogates, a surrogate pair, bidi controls, line breaks, U+2028/9), 5000 random strings over the dangerous characters, decoding back to the input, well-formed UTF-16; 16 addresses that must not become links; 12 references that must not become links; JSON that reads back equal.

## What was shown

Run on 6 October 2026 on the tree with Phases 2 and 3 and the other Phase 4 lanes uncommitted, while three other workers edited it. No benchmark ran (`pgrep -f 'benchmarks/[r]un.ts'` before each gate). Logs in `.retest/artifacts-policy/` and `.retest/html-report/` (both gitignored).

| Gate | Command | Result |
| --- | --- | --- |
| This lane's unit files | `node --conditions=retest-source --test tests/unit/store-artifacts.test.ts tests/unit/store-retention.test.ts tests/unit/media-policy.test.ts tests/unit/reporters-html-escape.test.ts` | 66 of 66 (30, 11, 15, 10) |
| Whole unit suite | `npm run test:unit` | 3799 of 3804; the 5 failures are in other lanes' files: `tests/unit/builds-lock.test.ts` 281, `tests/unit/evaluation-corpus-score.test.ts` 114, `tests/unit/evaluation-frames.test.ts` 491, `tests/unit/native-ios-simulator.test.ts` 299 and 342 (an earlier run, `test-unit-1.log`: 3591 of 3595, with 4 other failures in other lanes' files) |
| Type markers | `npm run test:types` | 241 of 241 markers on 6.0.3 and 7.0.2 (an earlier run failed only on `src/evaluation/frames.ts:97`, since fixed by its lane) |
| Typecheck, TypeScript 6 | `lockf -t 0 /tmp/retest-heavy-gate.lock node_modules/typescript/bin/tsc -p tsconfig.json` | 6 errors, none in this lane's files: `src/cli/inspect/test-timeline.ts`, `tests/integration/evaluation-frames.test.ts`, `tests/unit/evaluation-corpus-score.test.ts`, `tests/unit/inspect-looks.test.ts`, `tests/unit/runner-media-lifecycle.test.ts` (2), all other lanes' files mid-edit (`tsc6-3.log`; earlier runs showed other sets, all in other lanes' files) |
| Typecheck, TypeScript 7 | `lockf -t 0 /tmp/retest-heavy-gate.lock node_modules/typescript-7/bin/tsc -p tsconfig.json` | the same 6 and `tests/unit/runner-recording-fakes.ts`, none in this lane's files (`tsc7-3.log`) |

`npm run typecheck` itself stops at the first compiler's errors, so the two compilers were run one after the other, each through the lock.

Breaks tried, each restored at once: every `nlink > 1n` in `src/store/artifacts.ts` raised to `9n` fails 5 tests across `store-artifacts.test.ts` and `reporters-html-safety.test.ts` (with only the check's own copy raised, the open's second check still refuses, so nothing fails); `scriptJson` left writing `<` and `>` fails 3 tests across `reporters-html-escape.test.ts` and `reporters-html-safety.test.ts`.

Changed in this session: the test of a purpose, format or container outside the list now calls `artifactPath` through `Reflect.apply`, as a JavaScript caller or a parsed record would, instead of a value widened to `unknown` and cast back, and a thumbnail of a hostile purpose was added to it.

## For other lanes

- Recording-runner (`src/runner/**`, `src/store/**`, `src/config/**`, `src/protocol/**`): add the five proposed events to the schemas; write `artifact.removed` from `applyRetention`'s `removing` and drop removed files from the result and the rebuild; add the recording event type (with `kind: 'recording'`, `attemptId`, `of` on thumbnails) to `eventArtifactReferences` in `src/store/artifacts.ts` (this lane's file: ask, or the orchestrator edits it); add an app's `screenshots`/`recordings` rules to the config with `appPixelRulesSchema`; call the policy's `decide` before and after each failure screenshot, AI check screenshot, agent frame and recorded or live frame, and `beginSecretEntry` / `endSecretEntry` around `SecretFiller` fills; restart a screencast after a stretch ends; give a recording a placeholder frame at the start of a stretch so the video does not hold the last frame across it.
- Capture sources (`src/media/capture.ts`, drivers): a `withheld` count in `FrameTally` beside `dropped`, so a withheld frame is never counted dropped; a screenshot loop's frame should carry the moment its capture was asked for; each driver reads the field fact the policy needs (the `type` property of the element the keys go to, or the native element type) before the first key and after the last, and reports when the field is gone, empty or masked.
- HTML report (`src/reporters/html/**`): use `escapeHtml`, `pageHref`, `artifactHref` and `scriptJson` and nothing of its own; read artifacts through `readArtifactFile`, or `checkArtifact` and `open`, with a stated `maxBytes`. Done: the report does both and nothing else.

## Not shown

Most important first:

- Nothing in a run uses these modules yet. No run writes the new paths, applies retention or the pixel policy, or records the five proposed events; that is the recording-runner lane's wiring. Every claim here rests on unit tests in temporary folders, not on a real run.
- The pixel policy was never fed by a real driver. Whether each driver can read the field fact before the first key and after the last (the `type` property, the native element type), and see a field go, empty or mask, is untested; so is the overlap rule against a real screencast's timestamps.
- The swap race that remains (a folder flipped several times between the steps of one read) is not closed and cannot be from Node; the probe that hammered it ran in the first worker's session and its logs did not survive the restart.
- Linux was not tried: `O_NOFOLLOW`, `O_NONBLOCK`, bigint `dev`/`ino` and the error codes were exercised on macOS (APFS) only.
- Whether a reader built before the five proposed events refuses a folder holding one is reasoned from the schema's refusal of unknown event types, not run, since the events are not in the schema yet.
- The macOS window-crop rule (withhold while any session of the run has a stretch) is reasoned from how the crop is taken, not shown on a real crop with a secret on screen.
