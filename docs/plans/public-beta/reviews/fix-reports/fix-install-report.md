# Fix lane I (pinned builds, `retest install`, `doctor`): report

Repository: /Users/dragon/Documents/Projects/Gruvi/Products/retest. Nothing committed. Brief: `docs/plans/public-beta/codex/fix-round/fix-install.md`. Findings: `docs/plans/public-beta/reviews/phase-3-review-install-agent.md`, I-1 to I-9 and the builds lane's held items.

Logs of this pass are under `/tmp/retest-fix-install-logs/`. The earlier session's logs (`/tmp/retest-fix-install/`) and the review's reproductions (`/tmp/retest-review-install/`) did not survive the Mac's restart.

## What the earlier session left

The first session of this lane stopped at its session limit while waiting on the gate lock for its last typecheck. It left no report. Its transcript (`~/.claude/projects/-Users-dragon-Documents-Projects-Gruvi-Products-rehearsal/61cf9736-f97c-4ba3-b12b-3477164d42c0/subagents/agent-aef044a226d229843.jsonl`) shows every finding coded and tested, the install integration file 13 of 13 and m2-doctor 3 of 3. It edited doctor rows after that m2-doctor run, and it never ran a typecheck of its own files to the end. I read every file it changed against the findings. Each partial edit is whole. I found two more defects in its new code, below as I-8b and I-6b.

Its copy of the code as it stood before the fixes was in `/tmp` and is gone. I rebuilt that copy from its transcript's reads of each file (`/tmp/retest-fix-install-logs/before-src/`), put it over a copy of today's tree (`/tmp/retest-fix-install-logs/old-run/`) and ran today's tests there. Today's Firefox lookup asks `installedBuild`, which the old code lacks. So the old copy got one added function that answers as the old `installedExecutable` did: installed or missing, never damaged.

## Findings

"Old" is the rebuilt copy of the code before the fixes, with today's tests. Unit logs: `old-<file>.log`, `final-unit-<file>.log`.

| Id | Change (file:line) | Test that fails on the old code | Old / now |
| --- | --- | --- | --- |
| I-1 | `src/browser/builds.ts:640` a folder for a refused pin is `unverifiable` and its record is not read; `:712` the record's tree checksum must be the pin's; `:740` `--verify` holds the files against the pin's tree checksum. `installedBuild` (`:669`) answers `damaged` for such a folder, so no run gets its executable. `src/cli/install/report.ts:89`, `src/cli/install/doctor-rows.ts:133,150` never call it installed. | `builds-record`: "a folder for a pin retest install refuses is never installed…", "the record's tree checksum must be the pin's…"; `cli-install`: "lists a folder Retest did not install for a pin it refuses…"; `builds-doctor`: "never call a build of a pin install refuses installed…" | fail / pass |
| I-2 | `src/cli/install/lock.ts:32` the kernel lock of the desktop lock (`holdKernelLock`, `/usr/bin/lockf -k -s -t 0` with a child reading a pipe); a holder record beside it names the holder; `:65` the refusal names the lock file and, while it runs, the holder's pid, command and start; the lock file is never deleted. Lock path `<cache>/retest/locks/<build>.lock` (`install-archive.ts:126`). | `builds-lock`: six processes racing over a lock a dead holder left, three rounds (old: two holders at once in round 1); a killed holder frees it; a live holder with no record keeps it; a second release changes nothing. `builds-install`: "waits for no other installer…" | 0 of 4 and fail / 4 of 4 and pass |
| I-3 | `report.ts:88`, `doctor-rows.ts:166`: only a pin the install accepts can be damaged now, so "run the install again" is always a fix it accepts; a refused pin's folder gets "Remove the folder" and the reason. | `builds-doctor`: "never call a build of a pin install refuses installed, and give it a fix the install accepts" | fail / pass |
| I-4 | `builds.ts:669` `installedBuild` answers installed with the path, missing, or damaged with the folder and a message; `installedExecutable` (`:697`) stays for callers that need only a path. | `builds-installed` (2 tests) | 0 of 2 / 2 of 2 |
| I-5 | `src/cli/install/download.ts:56` `shownAddress` keeps origin and path only, for "Downloading … from", the checksum refusal and `fetchedFrom` (`install-archive.ts:181`); `report.ts:22` refuses a mirror with a query, fragment or credentials, by name, without printing it back. | `builds-install`: "refuses a mirror with a query, a fragment or credentials…"; `cli-install`: "refuses a mirror with a query or a fragment…"; integration "records and prints only the origin and path of the address a download was redirected to" (old run by the first session only: the record kept `?X-Amz-Signature=…`) | fail / pass |
| I-6 | `install-archive.ts:188` partial downloads of dead pids are deleted, of any build; `:97` the archive beside an already installed build is deleted. | `builds-install`: "deletes the partial downloads installs whose process is gone left…", "deletes an archive left beside a build that is already installed…" | fail / pass |
| I-6b (new) | The new partial sweep and the old staging sweep passed a pid read from a file name to `process.kill`, which throws `ERR_INVALID_ARG_TYPE` above 2^31-1, so a name like `….partial-99999999999` made the install throw. `install-archive.ts:204` `mayStillRun`: such a number is nobody's and its leftover is deleted; a check that throws keeps the leftover. | `builds-install`: "deletes a partial download and a staging folder named after a number no process can have, and goes on" | fail (`ERR_INVALID_ARG_TYPE`) / pass |
| I-7 | `src/cli/install/unpack.ts:50,85` after a failed, stopped or timed-out attach, `hdiutil info` is read (for up to 2 s after a stop) and an image mounted on this attach's mount point, or attached from this archive with no mount, is detached by its device; images mounted elsewhere are left. | `builds-unpack` (stand-in hdiutil whose helper mounts after a failed or stopped attach); integration "leaves no disk image attached when a stop lands during its attach…" with a real 20 MiB image (old run by the first session only: left mounted at a 100 ms stop) | 0 of 2 / 2 of 2 |
| I-8 | `builds.ts:440,471` every file is opened only after `lstat` shows a regular file, with `O_NOFOLLOW` and `O_NONBLOCK`, and must be the file the `lstat` saw; `:553` `scanTree` names links leaving the build, FIFOs, sockets, devices and set-id files; used at unpack (`install-archive.ts:265`) and before any tree checksum in `--verify` (`builds.ts:740`). `folderChecksum` in `src/native/executors.ts` is unchanged; the modes-in-checksum idea is written down in `proofs/builds.md` under "The cache and the record". | `builds-record`: "a full check finds a file given a set-id bit and a FIFO…", "a FIFO where a licence belongs…" (old: hung to the 10 s limit), "a link put where a pinned file was…"; `builds-install`: "refuses a FIFO, a socket and a file with a set-id bit…" | fail / pass |
| I-8b (new) | The record itself was still read with `readFile`: a FIFO at `build.json` hung `--list`, `doctor` and the install, and a link there was followed. `builds.ts:406` reads the record through the same regular-file open, refusing one over 1 MiB; `:781` checks the executor record with `lstat` before `readBuildRecord`, which follows links and waits on FIFOs itself. | `builds-record`: "a link or an oversized file where the record belongs…", "a FIFO where the record belongs…", "is damaged at once by a link or a FIFO where its record belongs…" | fail (link followed and called installed; FIFO hung to the 10 s limit) / pass |
| I-9 | `docs/plans/public-beta/proofs/builds.md`: the lock, the checks against the pin, the record read, the sweeps, the doctor rows, the old-code runs, the stale `/tmp` log paths, and the "Not verified" list. | record | done |
| Held: doctor refuses native targets | `src/cli/doctor/checks.ts:102` asks `targetDriver` with `{ native: true }`; `doctor-rows.ts:88` `checkNativeTarget` reads the executor build from the cache, then checks `appPath` is a folder. Nothing is built or started. | `builds-doctor`: "check a native target as a run drives it…"; `builds-doctor-native` (2 tests) | fail and does not load / pass |
| Copy (new) | `report.ts:171` after an install, the Firefox line said a target runs the build "once its executablePath names this path"; the Firefox lookup and doctor's row run it when the target names no path. Now "A Firefox target that names no executablePath runs it." | `cli-install`: "says how a target runs a build it installed…" | fail / pass |

What `doctor` reports for the two executors, read from this Mac's cache only (`native-doctor-real.txt`, exit 0; `native-doctor-real-no-app.txt`, exit 2):

```text
phone  { platform: 'ios-simulator', device: 'iPhone 17', runtime: '26.5' }  ✓ WebDriverAgent 16.13.6 built in Retest's cache · products sha256 0ddb9244e806, and the app is there; doctor starts neither
desk   { platform: 'macos' }                                                ✓ WebDriverAgentMac (appium-mac2-driver) 4.3.6 built in Retest's cache · products sha256 9c87eb50ea06, and the app is there; doctor starts neither
```

Not built: `✗ … is not built in Retest's cache`, fix `Run npx retest install <engine> to build it from its pinned commit; otherwise the first run builds it.` Damaged: what no longer matches, fix to remove the folder and install again (for the macOS runner, permissions granted again). No app: `✗ No app at …, the path appPath gives.`

The Firefox lookup: the one-line change I-4 called for is already in, made by the Firefox driver's lane: `src/browser/firefox/executable.ts:71-73` asks `installedBuild` and fails setup by name on `damaged`. That lane's `tests/unit/firefox-executable.test.ts:125` covers it, 10 of 10 here (`final-unit-firefox-executable.log`).

Held items closed by running: m2-doctor passed 3 of 3 on real Chrome with no "different identity" at close. The Chrome for Testing, Firefox and WebKit pins are still refused (no archive checksum, WebKit notices unpublished), and now the inspection paths refuse them too.

Nothing was downloaded from a publisher. The cache holds no pinned browser archive, and the brief allows no download.

## Not fixed, and why

- Settled under Follow-ups, item 3: `/usr/bin/lockf` does not exist on Linux, so the install lock refused there by name. Every Linux pin is refused before the lock today. A Linux route (`flock`) is written down in `proofs/builds.md` and not built, since nothing here can run it.
- The modes-in-checksum idea for `folderChecksum` is only written down: changing it would change every recorded and pinned tree checksum, and that file belongs to another lane.

## Other lanes' files

- Settled under Follow-ups, item 1: `tests/unit/runner-target-drivers.test.ts:432-460` still expected doctor's old rows for native targets ("Retest has no driver for iOS simulator apps yet…", "…macOS apps yet…"). With the held item fixed, doctor reads the executor cache. That test gives no `HOME`, so the two rows now read `HOME is not set to an absolute folder, so Retest has no cache to read the WebDriverAgent 16.13.6 build from.` and `… the WebDriverAgentMac (appium-mac2-driver) 4.3.6 build from.` The rows are still `ok: false`. Reproduce: `node --conditions=retest-source --test tests/unit/runner-target-drivers.test.ts`. The orchestrator decides whether to change those two expected rows and the title ("refuses each target that has no driver yet"), or to undo the held-item change in `src/cli/doctor/checks.ts:102-103`.
- Settled under Follow-ups, item 2: `src/native/executors.ts:300` `readBuildRecord` read `build.json` with `readFile`: a FIFO there hangs and a link is followed. `doctor` and `--list` now check it first; a native run (`ensureExecutorBuild`, `src/runner/native-pool.ts`) does not. Reproduce: replace an executor build's `build.json` with `mkfifo`, then start a native run.
- A native run still builds an executor itself when none is recorded (`src/runner/native-pool.ts:428`), as the review held.

## Gates

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/builds-*.test.ts tests/unit/cli-install.test.ts tests/unit/cli-doctor.test.ts`, before this pass's changes | 105 pass, 0 fail | `unit-lane-before.log` |
| the same, after | 110 pass, 0 fail | `unit-lane-after-1.log` |
| each file alone, after: builds-pins 9, builds-record 26, builds-download 8, builds-install 18, builds-lock 4, builds-installed 2, builds-unpack 2, builds-doctor 10, builds-doctor-native 2, cli-install 12, cli-doctor 17, firefox-executable 10 | all pass | `final-unit-<file>.log` |
| the same files on the old copy, each run directly under a 150 s alarm | pins 9 and download 8 and cli-doctor 17 pass; record killed at the alarm on the hung FIFO reads with every new test failed; install 12 pass 6 fail; lock 0 of 4; installed 0 of 2; doctor 8 pass 2 fail; doctor-native does not load; unpack 0 of 2; cli-install 9 pass 3 fail | `old-<file>.log` |
| the three tests added in this pass, on today's code before the fix | all fail | `new-tests-on-current-*.log` |
| `lockf … npm run typecheck` | exit 2. TypeScript 6.0.3 stopped the chain: 5 errors, all in `src/evaluation/frames.ts`, `tests/unit/evaluation-frames.test.ts`, `fixtures/evaluation-corpus/runner/score.ts`; none in this lane's files | `gate-typecheck.log` |
| `lockf … node_modules/typescript-7/bin/tsc -p tsconfig.json` | exit 1, the same 5 errors in the same files; none in this lane's files; no FATAL | `gate-typecheck-ts7.log` |
| `lockf … node_modules/typescript/bin/tsc -p examples/tasks/tsconfig.json` | exit 0 | `gate-typecheck-examples.log` |
| `lockf … node --conditions=retest-source --test --test-concurrency=1 tests/integration/install.test.ts` | 13 pass, 0 fail; no test image left attached | `gate-integration-install.log` |
| `lockf … node --conditions=retest-source --test --test-concurrency=1 tests/integration/m2-doctor.test.ts` | 3 pass, 0 fail, real Chrome | `gate-integration-m2-doctor.log` |
| `npm run test:types` | exit 1: one unexpected error, `src/evaluation/frames.ts:97` TS2345, on both compilers | `gate-test-types.log` |
| `npm run test:unit` | 3575 tests, 3558 pass, 17 fail. Outside this lane: `diagnostics-engines` 10 and `diagnostics-run` 1 (diagnostics lane); `cli-help` 2 and `cli-run` 1 (the new `report` command in the list of commands); `playwright-resolve` 2 (the founder's resolve hook). From this lane's held-item change: `runner-target-drivers.test.ts:432`, above. `tests/unit/diagnostics-engines.test.ts` hung in my run as in pid 36744's; I ended my own child of it (pid 57173) so the suite could finish. | `gate-test-unit.log` |
| `retest install --list --verify --json` on this Mac's real cache, read-only | exit 0; both executors installed with the recorded products checksums, so their records pass the new check | `real-list-verify.json` |

`lockf …` is `lockf -t 5400 /tmp/retest-heavy-gate.lock`, run from `heavy-gates.sh` and `heavy-gates-2.sh` in the log folder, which check `pgrep -f "node.*benchmarks/run\.ts"` first. No benchmark ran.

Processes: an alarm-killed `node --test` of my own left its child (pid 43267, hung on a test FIFO) behind; I ended it. Nothing of mine is left running. No disk image is attached and no install mount point is left.

## Not verified, most important first

1. No download from a publisher, so no Chrome for Testing, Firefox or WebKit archive checksum, and those three stay refused.
2. The two integration cases' old-code failures (the redirect's query in the record, an image left mounted after a stopped attach) rest on the first session's run. Its logs are gone, and its transcript (calls 173 to 176) holds the output. I did not rerun them on the old copy, since the stopped attach leaves a real image mounted.
3. `runner-target-drivers.test.ts:432` fails until the orchestrator settles it, above.
4. A native run's own read of an executor record (`src/native/executors.ts:300`) can still hang on a FIFO.
5. Linux: the install lock, `unzip`, and the Linux Chrome for Testing pin have never run.
6. A real Firefox disk-image install, and an image that asks for a licence agreement.
7. Device files at unpack or verify: no device can be made without root, so their refusal rests on the same `lstat` branch as the FIFOs and sockets the tests made.
8. The full unit and type gates on a quiet tree: other lanes were editing during this pass.

## Files changed

This pass:
- `src/browser/builds.ts` (regular-file open shared by file hashes and the record, record size limit, executor record check)
- `src/cli/install/install-archive.ts` (`mayStillRun` in both sweeps)
- `src/cli/install/report.ts` (Firefox line after an install)
- `tests/unit/builds-record.test.ts` (3 tests), `tests/unit/builds-install.test.ts` (1 test), `tests/unit/cli-install.test.ts` (1 test)
- `docs/plans/public-beta/proofs/builds.md`
- this report

The first session, by its transcript, all inside the lane:
- `src/browser/builds.ts`, `src/cli/commands/install.ts`
- `src/cli/install/{lock,install-archive,download,report,doctor-rows,unpack,install-executor}.ts`
- `src/cli/doctor/checks.ts`
- `tests/unit/builds-fixtures.ts`, `builds-install.test.ts`, `builds-record.test.ts`, `builds-doctor.test.ts`, `cli-install.test.ts`
- new `tests/unit/builds-lock-holder.ts`, `builds-lock.test.ts`, `builds-installed.test.ts`, `builds-doctor-native.test.ts`, `builds-unpack.test.ts`
- `tests/integration/install.test.ts`
- `docs/plans/public-beta/proofs/builds.md`, and the installation and `doctor` lines of `docs/guide.md`

No dependency, script or environment change. No test title in the lane's files was removed.

## Follow-ups

The coordinator settled the three open items and gave them to this lane. Logs are in the same folder, prefixed `followup-`.

### 1. `tests/unit/runner-target-drivers.test.ts`: doctor's rows for native targets

The doctor change stays. The test that pinned the old "no driver yet" rows (`:432`) is replaced by two cases, which fail on the pre-fix `checks.ts` (`followup-runner-target-drivers-old.log`, 2 fail) and pass now (`followup-runner-target-drivers-after.log`, 22 of 22):
- "reads an iOS simulator and a macOS target from an empty executor cache under HOME, with the command that builds each, refuses a WebKit target with no build by name, and launches only the Chromium target": a temporary HOME. It asserts every row with its fix, the `builds` row the WebKit target now gets, one launch, and nothing written under HOME. It is skipped by name off macOS arm64, where no executor is pinned.
- "says a native target has no executor cache to read when HOME is not set, and starts nothing": the HOME rows, on their own.

The old title "refuses each target that has no driver yet, as a run does, refuses a WebKit target with no build by name, and launches nothing for either" is gone. Native targets have had a driver since Phase 2, and doctor now checks them as a run drives them.

A valid executor build is not written here, because it is not cheap. Doctor checks the pinned licence texts by checksum, only a real build carries those upstream texts, and `runChecks` takes no pins to swap in. The installed row is held by `builds-doctor-native.test.ts` with stand-in pins, and by the read-only run on this Mac's real cache (`followup-native-doctor-real.txt`, two ✓ rows, exit 0).

### 2. `src/native/executors.ts`: the executor record read unchecked

- The regular-file reader moved from `src/browser/builds.ts` to a new `src/shared/regular-file.ts`. It holds `openRegularFile`, `readFileSha256` and `readRecordText` (refusing anything over 1 MiB), plus `entryKind` and `describeRefusal`. It could not stay in builds.ts: builds.ts imports executors.ts at load, so executors.ts importing builds.ts would make a cycle.
- `readBuildRecord` (`src/native/executors.ts:297`) reads through `readRecordText`. A link there is never followed and a FIFO is never waited on. A native run then refuses by name ("The executor build record … cannot be read: it is a FIFO, not a file. Remove … to build again."), and doctor says the same. builds.ts dropped the guard it had put in front of `readBuildRecord`.
- `verifyRecordedBuild` (`:412`) also hashed the record's `xctestrun` path with `readFile`, which would hang a run the same way. It now uses `readFileSha256`, and a FIFO there is refused by name.
- Tests in `tests/unit/native-executors.test.ts`:
  - "the build record is read only as a regular file: a link is never followed, a FIFO never waited on": direct, cross-platform; covers a link, an oversized file and a FIFO.
  - "a run reusing a build is refused by name, never held or misled, by a link or a FIFO at its record or test run file": through `ensureExecutorBuild` with the stand-in tools; macOS only, like its neighbours, since the build lock is `lockf`.
- On a copy of today's tree with only these edits reverted (`old-executors-run`), both tests failed by assertion: the linked record was followed and the build reused (`followup-native-executors-old.log`). A FIFO at the record left the old reader "still waiting after 3 s"; that probe could not even exit and was ended (pid 35471). The fixed reader answers `it is a FIFO, not a file` at once (`followup-fifo-record-probe.log`).
- Now 19 of 19 (`followup-unit-native-executors.log`). The other unit files that import executors.ts (native-identity, native-ios-simulator, native-macos-app, runner-native-run-end) pass 82 of 82 (`followup-unit-executor-importers.log`).

### 3. The install lock without `lockf`

`src/cli/install/lock.ts` was rewritten. It uses no `lockf` and no macOS-only call: only files, folders, `link`, `process.kill(pid, 0)` and `ps -o lstart=,args= -p <pid>`, through `commandOf` and `readOwnStart` in `src/native/processes.ts`, which the desktop lock judges its holder with.

- **Design.** The lock is the folder `<cache>/retest/locks/<build>.lock`, holding generations:
  - `<n>.json` names the holder of generation n by pid, start (as `ps` reads it) and program;
  - `<n>.released` says it let go.

  A taker reads the newest generation `n` and makes `n+1` only when `n` was let go, or `ps` shows its pid absent or started at another time. It makes it by linking a finished file under that name.
- **Why it holds.** The link fails rather than replaces, so exactly one taker makes each generation. Nothing is ever removed or replaced, so no name is made twice and a dead holder is passed over, never deleted. A holder `ps` cannot read, or a generation file that cannot be read, is never passed over; the refusal says so and what to do.
- **Holder's own record.** It never holds the full command line, only the program and entry script, so no argument reaches a file.
- **First design, replaced.** It was one ticket per taker, with withdrawal on conflict. It kept mutual exclusion, but six racers livelocked (one entry in 20 s, `followup-lock-after.log` from that run), because every check spends milliseconds in `ps` while the other tickets are visible.
- **Guarantees the old tests asserted, kept by name:** the race (six processes, three rounds, over a lock a dead holder left: each enters once, never two at once, each refusal names the lock); the refusal naming the lock and the live holder, freed once that holder is SIGKILLed; release only by its own holder. Each passes, 6 of 6, five runs in a row (`followup-lock-repeat-*.log`).
- **Title replaced:** "is not taken from a live holder whose record is missing or empty" became "is not taken from a live holder however long it has held it, nor through a generation that cannot be read". In the kernel lock the holder's record sat apart from the lock and could go missing while the lock held. Now the record is the lock and appears whole, so "missing" no longer applies. "Empty" is kept: an emptied generation is never passed over.
- **New cases:** a pid reused by a process with another start is passed over; a live process's generation is not; a `ps` that cannot answer leaves the holder alone; a file where the lock's folder belongs is named and left there.
- **Broken copies, each caught by the test meant for it** (`mutant-*.log`):
  - linking replaced by a rename that overwrites: two installers at once in round 1 of the race, 3 runs of 3;
  - a generation older than a minute passed over: the holder of three hours lost its lock;
  - a holder `ps` cannot read passed over: its lock was taken;
  - this process's own holding ignored: it got in twice.
- `builds-install` 18 of 18 and the install integration file 13 of 13 under the lock run on the new lock (`followup-integration-install.log`).
- **Linux not run.** Nothing here runs Linux. The lock needs a `ps` that prints `lstart`, which procps does. BusyBox's `ps` does not, and there Retest cannot read its own start, so it refuses the install by name. The guide and `proofs/builds.md` say how the lock works, with no claim that it ran on Linux.

### Gates after the follow-ups

| Command | Result | Log |
| --- | --- | --- |
| Each unit file alone: builds-pins 9, builds-record 26, builds-download 8, builds-install 18, builds-lock 6, builds-installed 2, builds-unpack 2, builds-doctor 10, builds-doctor-native 2, cli-install 12, cli-doctor 17, firefox-executable 10, native-executors 19, runner-target-drivers 22 | all pass | `followup-unit-<file>.log` |
| native-identity, native-ios-simulator, native-macos-app, runner-native-run-end | 82 of 82 | `followup-unit-executor-importers.log` |
| `lockf … node_modules/typescript/bin/tsc -p tsconfig.json` | exit 2, 6 errors, none in this lane's files: the 5 earlier ones in the evaluation lane's files, and 1 in `tests/unit/media-protocol.test.ts` (media lane, in flight) | `followup-typecheck-ts6.log` |
| `lockf … node_modules/typescript-7/bin/tsc -p tsconfig.json` | exit 1, the same 6, none in this lane's files | `followup-typecheck-ts7.log` |
| `lockf … tsc -p examples/tasks/tsconfig.json` | exit 0 | `followup-typecheck-examples.log` |
| `lockf … tests/integration/install.test.ts` | 13 of 13; no test image left attached | `followup-integration-install.log` |
| `lockf … tests/integration/m2-doctor.test.ts` | 3 of 3, real Chrome | `followup-integration-m2-doctor.log` |
| `npm run test:unit` | 3594 tests, 3586 pass, 8 fail, all in `tests/unit/diagnostics-engines.test.ts` (diagnostics lane); `runner-target-drivers` passes in the full suite | `followup-test-unit.log` |
| `install --list --verify --json` on this Mac's real cache, read-only | exit 0, both executors installed with the recorded checksums | `followup-real-list-verify.json` |
| `doctor` on a native config, real cache, read-only | exit 0, two ✓ rows | `followup-native-doctor-real.txt` |

`lockf …` is `lockf -t 5400 /tmp/retest-heavy-gate.lock`, from `heavy-gates-3.sh`.

### Files changed by the follow-ups

- `src/shared/regular-file.ts` (new)
- `src/browser/builds.ts` (imports the shared reader)
- `src/native/executors.ts` (record and `xctestrun` read)
- `src/cli/install/lock.ts` (rewritten)
- `src/cli/install/install-archive.ts` (comments on the lock)
- `tests/unit/runner-target-drivers.test.ts` (the doctor cases), `tests/unit/native-executors.test.ts` (2 tests), `tests/unit/builds-lock.test.ts` (rewritten), `tests/unit/builds-install.test.ts` and `tests/unit/builds-fixtures.ts` (comments)
- `docs/plans/public-beta/proofs/builds.md`, `docs/guide.md` (the lock line)

No dependency, script or environment change.

### Not verified after the follow-ups, most important first

1. The install lock on Linux: written with no macOS-only call, run only on macOS.
2. A real native run against a FIFO or link at an executor record: shown through `ensureExecutorBuild` with stand-in tools, not with Xcode and a simulator.
3. A valid executor build in the runner doctor test: not cheap, for the reason above.

## After the review

An independent review of the folder lock and the regular-file reader found ten defects. All are fixed, each with a test that fails on the code before the fix or on a copy without the defence. Logs are under `/tmp/retest-fix-install-logs/review/`.
- "Before-review" is today's tree with the pre-review `lock.ts` and the pre-change `processes.ts` (`before-review-run`, logs `before-review-*.log`).
- "Copy" is today's tree with one defence removed (`lock-<name>`, `reader-<name>`, logs of the same name).

### 1. Two holders at once across time zones (high)

**At the source.**
- **Where the zone leaked in.** `ps` prints a start in the zone of the process that runs it.
  - Readers that already ignored the caller's zone: every metadata-process reader runs `ps` with exactly `{ PATH, LC_ALL }` and never inherits TZ. That covers `process-ownership.ts`, the process table in `processes.ts`, `firefox/process-table.ts`, `webkit/process.ts` and `media/client.ts`; they always print the system zone.
  - Readers that inherited it: only the `runCommand` readers in `processes.ts` (`commandOf`, `listProcesses`, `killRecordedNow`, line 642ff.) took the caller's whole environment, TZ included. The install lock, the desktop lock and the temp-folder sweep read starts through those.
- **The change.** That one change is in `processes.ts`: those three readers drop the caller's TZ (`readingHidden`), so `ps` prints the system zone like every other reader. `process-ownership.ts` needed no change; its readings already ignore the caller's zone, which the new test shows.
- **Why not `TZ=UTC0` everywhere.**
  - Firefox records its process by the ownership layer's reading and compares it with its own reader's at `firefox/process.ts:274` and `orphans.ts:157,163`. Moving only the two named readers to UTC would make those comparisons fail on every machine not set to UTC, and Firefox's files are an active lane's.
  - Every record already written holds a system-zone string. Those are the desktop lock's record, the temp folders' owner files, Firefox profiles and WebKit homes. Read back in UTC, they would stop matching. The temp-folder sweep and the Firefox orphan sweep act on a mismatch by removing a folder or ending a process.
  - The change that would do it: `TZ=UTC0` once in `src/shared/metadata-process-worker.ts` and in `processes.ts`'s reading environment, together, once the Firefox and media lanes are done, with stored starts compared as instants and a string written without a marker read as system-zone time. Until then, a change of the machine's time zone setting while processes run shifts every start reading except the install lock's.
- **Stored starts checked.**
  - Desktop lock and temp folders: `holderStartedAt`, `runnerApps[].startedAt` and the folder owner come from `readOwnStart`/`commandOf`/`listProcesses` and are compared with `commandOf`. Records written before the change by a caller without TZ were already in the system zone, so they still compare like with like. One written by a caller that had TZ set compared wrongly before too, and now no newer reading repeats the mistake.
  - Firefox profiles and WebKit homes: unchanged readers, unchanged strings.
  - Install lock: has its own reader now (below). Generations of the earlier format, which only test folders ever held, are refused as unreadable.
- **Test.** `tests/unit/native-process-zone.test.ts`: two readers in zones 26 hours apart (`Etc/GMT+12`, `Etc/GMT-14`) read one live process with `commandOf` and with the process table. Before: `commandOf` gave `Mon Oct 5 08:01:44` and `Tue Oct 6 10:01:44` for the same process (`zone-before.log`). Now all four agree (`zone-after.log`).

**In the lock** (`src/cli/install/process-start.ts`, new; `lock.ts`):
- **Own reading.** The lock reads starts itself, on a clock nothing can move afterwards: macOS `ps -o lstart=` under `TZ=UTC0`, parsed to seconds; Linux `/proc/<pid>/stat`, item 2.
- **Pass-over rule.** A holder on this machine is passed over only when its pid has no process, or when the process under it started after the recorded holder did. Two processes never hold one pid at once, so that one can only be another.
- **Never pass over.** Equal means running. An earlier start, a start on another clock, or a reading that fails keeps the lock and refuses by name. A mismatch alone is never permission.
- **Test, real processes:** "keeps a holder that took it in one time zone from a taker in another, both real processes". The holder runs under `Etc/GMT+12`, the taker in a separate process under `Etc/GMT-14`. Before-review: the taker answered `held` beside the live holder (`before-review-lock.log`). Now: refused, naming the holder. Copy without `TZ=UTC0` in the lock's reader (`lock-tz.log`): fails the same way. Copy where an earlier start counts as gone (`lock-unsure.log`): two tests fail.

### 2. Linux clock step

On Linux the lock reads field 22 of `/proc/<pid>/stat`, the ticks from boot to the process's start, which a step of the wall clock does not move. `parseProcStat` counts from the last bracket, so a name with spaces and brackets reads right. The macOS route stays `ps` in UTC. The machine identity includes the boot id, so ticks are compared only within one boot.

Tests in `tests/unit/builds-process-start.test.ts`:
- the parser on fixed `/proc` lines;
- the judgement with fake readings on both clocks: absent, later, same, earlier, unreadable, another clock.

A copy that reads field 23 fails the parser test (`lock-procstat.log`). **This has not run on Linux.**

### 3. A cache shared across machines or pid namespaces

- **Machine identity.** Every generation records its machine, without the hostname in what is compared: on Linux the boot id and `readlink /proc/self/ns/pid`, on macOS `sysctl kern.bootsessionuuid`. Both are new at every boot. The hostname is kept for messages only, since a Mac's name changes with its network.
- **Refusal.** A generation of another machine or container is never judged; the install is refused by name, telling the user to give each machine its own cache or to remove the folder once no install runs there. A let-go generation is free from anywhere.
- **Hidden files.** They carry a tag of the machine. The sweep removes only this machine's, and only a gone writer's.
- **Docs.** The comment, the guide and `proofs/builds.md` now say one install at a time on one machine; installs from machines or containers sharing a cache are not coordinated, and while one holds the lock an install from another is refused.
- **Test:** "refuses a generation of another machine or container by name…". Copy without the machine check: two tests fail (`lock-foreign.log`). The before-review lock cannot read the new format at all, so its run shows nothing here.

### 4. Reader size bound

`readRecordText` reads at most one byte past 1 MiB into a fixed buffer from the descriptor it checked, and refuses when the extra byte arrives ("it grew past the 1048576 bytes…").

Test in `tests/unit/regular-file.test.ts`: the file grows by 3 MiB after it is opened. A copy that reads the whole file fails it (`reader-unbounded.log`).

### 5. Each defence of the open has a test

`openRegularFile` has a hook between its check and its open, and `readRecordText` one after the open. Each case below was run against a copy without its defence:

| Swap between check and open | Defence it needs | Copy without that defence |
| --- | --- | --- |
| A FIFO | `O_NONBLOCK`: the FIFO opens at once and reads as replaced | hung until the alarm (`reader-nonblock.log`) |
| A link to the very file that was checked (same inode, so only refusing to follow it tells) | `O_NOFOLLOW`; `ELOOP` now reads as replaced | failed (`reader-nofollow.log`) |
| Another regular file renamed over it | the inode and device comparison | failed (`reader-inode.log`) |

### 6. Where "no lock is left" was asserted

The old assertions looked beside the build and in `browsers/`, where the lock never is. They are replaced by the useful fact: after an install, the newest generation of `<cache>/retest/locks/<build>.lock` is released, its mark matching its token.
- Unit: `tests/unit/builds-install.test.ts`, the checksum-refusal and lock tests.
- Integration: `tests/integration/install.test.ts:105`.
- Record: `proofs/builds.md`.

A copy whose release does nothing fails both unit tests (`lock-norelease.log`); the old assertions passed on such a copy.

### 7. Stale record lines

In `proofs/builds.md`:
- line 47: the Firefox lookup asks `installedBuild` now;
- line 54: the executor record is read through the shared reader, with retries and the bound;
- the lock paragraph, the Linux paragraph and the shared-cache sentence;
- "Not verified" items 9 and 12.

### 8. A late release freeing a later generation

- Generations carry a random token, and the released mark is named `<n>.<token>.released`; a taker counts only the mark of the generation file beside it.
- A release first reads `<n>.json` and marks it only while the token is its own.
- Test: a holder releases late, after the folder was removed and another process made generation 1 again; the release reports that nothing was let go and the other holder stays held.
- Before-review: the late release reported success, writing an untokened mark that would free any later generation 1. A copy without either defence fails (`lock-token.log`). A copy with only one of the two removed still passes, because each alone protects.

### 9. A build called damaged while its record is renamed into place

`readRecordText` and `readFileSha256` read a file swapped between check and open again, up to three times, before they judge it. That covers `readBuildRecord` during `refreshNotices`'s rename and every checksum `builds.ts` takes. Test: a writer renames a new record into place during the read, and the new one is read. A copy with one attempt fails it (`reader-retry.log`).

### 10. Refusals, the stop, fsync

- **Refusals, not throws.** A lock folder that cannot be read, and a gone writer's file that cannot be removed, are refusals by name. Before-review: the take threw.
- **The stop.** `takeInstallLock(path, { tools, signal })` takes the install's signal, and `installArchive` passes it, so every `ps` wait stops with the install; the refusal says it was stopped. Test: a stand-in `ps` that answers nothing for 30 s; the take ends as stopped within 5 s. A copy that does not hand the signal to its reader took 14 s (`lock-signal-2.log`). The first form of this test supplied its own reader and missed that copy; it was rewritten.
- **fsync.** Each generation file and each released mark is flushed before it is linked or counted, and the folder after. **No test can cut the power.**

### Bounded growth

The folder keeps the newest two generations and their marks. The taker that just made the newest removes the older ones, and only after checking its generation is still the newest. A taker that made a generation under a number already removed sees a newer one and steps back. A holder's release checks its token first. A taker that finds the newest gone reads the folder again.

Test: after twelve installs, four files are left. A slow taker that judged generation 13 free while three installs made and removed generations made the removed name again, stepped back, and holds the newest, with nobody beside it. A copy without the step back fails (`lock-verify.log`).

### A test made to stop where it means to

- **What failed.** The first gate run after the review failed "stops a download that is interrupted…" in `tests/integration/install.test.ts` once (`gate-integration-install.log`). The test stopped the install a fixed 300 ms after it began. Under load right after a typecheck, the lock's readings (`sysctl` and `ps`, two spawns) took longer, so the stop landed in the lock rather than the download.
- **The test.** It now stops the install once the stand-in server has sent the first bytes, so the download is what it interrupts. Its assertions are unchanged.
- **The lock.** It reads the machine identity once per process, since neither the boot nor the pid namespace can change while a process runs; a failed reading is read again.

### Gates after the review

| Command | Result | Log |
| --- | --- | --- |
| Each unit file alone: builds-lock 12, builds-process-start 7, builds-install 18, cli-install 12, regular-file 6, native-process-zone 1, builds-record 26, builds-doctor 10, builds-doctor-native 2, builds-installed 2, builds-unpack 2, builds-download 8, builds-pins 9, cli-doctor 17, native-executors 19, runner-target-drivers 22, firefox-executable 10 | all pass | `unit-*.log`, `last-unit-*.log` |
| The eight other unit files that import `processes.ts` (native-capture, native-desktop-lock, native-diagnostics, native-logs, native-processes, native-secrets, native-session, runner-native-diagnostics) | 171 of 171, the desktop lock's real-process races among them | `unit-process-importers.log` |
| `npm run test:unit` | 3629 of 3629 pass, 0 fail | `gate-test-unit.log` |
| `lockf … tsc` (TypeScript 6.0.3) | exit 2, 1 error, `tests/integration/diagnostics-engines.test.ts:540` (diagnostics lane); none in this lane's files | `last-typecheck-ts6.log` |
| `lockf … typescript-7 tsc` | exit 1, the same single error; none in this lane's files | `last-typecheck-ts7.log` |
| `lockf … tsc -p examples/tasks/tsconfig.json` | exit 0 | `last-typecheck-examples.log` |
| `lockf … tests/integration/install.test.ts` | 13 of 13, no test image left attached | `last-integration-install.log` |
| `lockf … tests/integration/m2-doctor.test.ts` | 3 of 3, real Chrome | `last-integration-m2-doctor.log` |
| Read-only, this Mac's real cache: `install --list --verify --json`, and `doctor` on a native config | exit 0, both executors installed with their recorded checksums; two ✓ rows | `real-list-verify.json`, `native-doctor-real.txt` |

- An earlier batch had 5 errors in this lane's `lock.ts`. TypeScript had narrowed `signal.aborted` after the first check, and the held lock was typed as the whole union. They were fixed with a `stoppedBy` call and a `HeldLock` type (`gate-typecheck-ts6.log`).
- `lockf …` is `lockf -t 5400 /tmp/retest-heavy-gate.lock`, from `heavy-gates-6.sh`, which checks for a running benchmark first.
- Nothing of this lane's is left running, attached or mounted.

### Files changed after the review

- `src/cli/install/lock.ts` (rewritten)
- `src/cli/install/process-start.ts` (new: start readers, parsers, comparison, machine identity)
- `src/cli/install/install-archive.ts` (signal and stopped passed through)
- `src/shared/regular-file.ts` (hooks, `ELOOP` as replaced, retries, bounded read)
- `src/native/processes.ts` (the three `runCommand` readers drop the caller's TZ; one change)
- `tests/unit/builds-lock.test.ts` (rewritten), `tests/unit/builds-lock-holder.ts` (`try` mode), `tests/unit/builds-fixtures.ts` (`holdLockInChild` environment, `lockState`), `tests/unit/builds-install.test.ts` (lock assertions)
- new `tests/unit/builds-process-start.test.ts`, `tests/unit/regular-file.test.ts`, `tests/unit/native-process-zone.test.ts`, `tests/unit/native-process-zone-probe.ts`
- `tests/integration/install.test.ts` (lock assertion, a deterministic stop)
- `docs/plans/public-beta/proofs/builds.md`, `docs/guide.md` (the lock line)

No dependency, script or environment change.

**Titles changed in `builds-lock.test.ts`, each for its new guarantee:**
- "passes over a holder whose pid now belongs to a process started at another time, and never one whose process ps cannot read" became "…belongs now to a process that started after it, and never one whose start proves nothing or cannot be read". A different start alone no longer passes a holder over.
- The stop test is now "a stop while a process's start is read ends the take at once, as stopped". It goes through the lock's own reader.

### Not verified after the review, most important first

1. Linux: `/proc` start ticks, the boot id and pid namespace, and the whole lock there. Unit-tested with fixed text and fake readings; never run on Linux.
2. The `TZ=UTC0` change at the source is not made, for the reasons under item 1. Until it is, a change of the machine's time zone setting shifts every `ps` start reading except the install lock's, so the desktop lock and the temp-folder sweep can misjudge a live owner.
3. A power loss: fsync is called on every generation, mark and folder; no test can cut the power.
4. Two real containers, or two machines, sharing one cache: shown with a generation written under another machine's identity, not with a real second machine.
5. Removing only one of the two late-release defences (the token check on release, the token in the mark's name) is not caught by a test, because each alone protects. Removing both is caught.
