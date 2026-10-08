# Report: pinned builds, `retest install` and `doctor`

## What was built

- `src/browser/builds.ts` (new) holds the pinned set as data: seven pins, each with its engine, version or build, platform, source address, archive SHA-256 where known, executable SHA-256 and the licence files expected inside the build. The two executor pins are read from `src/native/executors.ts`, not copied. It also holds:
  - `pinRefusal`, which refuses a pin with uninspected notices, a pin published without its notices (each named), or a pin with no archive checksum
  - the cache layout (`~/Library/Caches/retest/browsers/<engine>-<version>-<platform>/{build/,build.json}`, or the XDG cache on Linux; executors stay under `…/retest/native-executors`) and the record schema
  - `inspectBuild` and `inspectBuilds`, which read files only, with an optional full-tree check
  - `installedExecutable(engine, env)`, which drivers call for an installed, matching build. The Firefox lane already does.
- `src/cli/install/` (new):
  - `download.ts`: https, or http to this machine only; redirects followed by hand; size, idle, total and interrupt limits; the hash taken on the way; no partial file left
  - `unpack.ts`: `ditto`, `unzip`, or `hdiutil` for disk images, always detached
  - `lock.ts`: one install of a build at a time, across processes
  - `install-archive.ts`: refuse first, then download, verify, unpack into staging, check the executable, pinned files, notices and links, record, rename, delete the archive; a verified archive is kept when unpacking fails
  - `install-executor.ts`: builds an executor through `ensureExecutorBuild` from the checkouts a native run uses, cloning nothing
  - `report.ts`: terminal and JSON output
  - `doctor-rows.ts`: the `builds` rows
- `src/cli/commands/install.ts` (new) is `retest install <engine...>`, `--list`, `--verify` and `--json`, with `RETEST_DOWNLOAD_MIRROR`. It is registered in the command list in `src/cli/cli.ts`, which is where commands are registered.
- `src/cli/doctor/checks.ts` got one import and one line in `runChecks`, which appends the `builds` rows after the targets and servers and before the secrets. The rows read the cache only:
  - an installed build a target runs, with its version and checksum
  - a damaged build, with the fix
  - a configured path that wins over an installed build
  - the installed build for a target that names no path, which Firefox runs and Chromium and WebKit run once a path names it
  - a Chromium or WebKit target with no build and none installed, with the install command or the refusal
- Tests:
  - unit: `tests/unit/builds-{pins,record,download,install,doctor}.test.ts` with `tests/unit/builds-fixtures.ts`, and `tests/unit/cli-install.test.ts`
  - integration: `tests/integration/install.test.ts`
- Records: `docs/plans/public-beta/proofs/builds.md`, and the guide's installation text in `docs/guide.md`.

## Commands and results

| Command | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/builds-pins.test.ts` | 9 pass | `/tmp/retest-builds-lane/unit-pins.log` |
| `… tests/unit/builds-record.test.ts` | 18 pass | `/tmp/retest-builds-lane/unit-record.log` |
| `… tests/unit/builds-download.test.ts` | 8 pass | `/tmp/retest-builds-lane/unit-download.log` |
| `… tests/unit/builds-install.test.ts` | 13 pass | `/tmp/retest-builds-lane/unit-install.log` |
| `… tests/unit/builds-doctor.test.ts` | 8 pass | `/tmp/retest-builds-lane/unit-doctor.log` |
| `… tests/unit/cli-install.test.ts` | 9 pass | `/tmp/retest-builds-lane/unit-cli.log` |
| `… builds-*.test.ts cli-install cli-help cli-doctor runner-target-drivers`, together | 111 of 111 before the driver lanes wired Firefox and WebKit; last run 105 of 113, all 8 failures in `runner-target-drivers.test.ts`, which expects WebKit refused | `/tmp/retest-builds-lane/unit-mine-2.log`, `unit-mine-4.log` |
| `lockf … node --conditions=retest-source --test --test-concurrency=1 tests/integration/install.test.ts` | 11 pass, run five times as the code settled; the last run is on the final tree | `/tmp/retest-builds-lane/integration-install-5.log` |
| `lockf … npm run typecheck` | exit 0 on TypeScript 6.0.3 and 7.0.2 and the examples project (`typecheck-4.log`). The last run after my final edits exited 2, with two errors, both in the Firefox lane's in-progress `tests/unit/firefox-scripted-bidi.ts` (TS18030), and none in this lane's files | `/tmp/retest-builds-lane/typecheck-4.log`, `typecheck-5.log` |
| `lockf … node … tests/integration/m2-doctor.test.ts`, twice | 2 of 3 each time. Its first test fails on "Chrome 153.0.8010.12 started, then did not close: Recorded process … has a different identity", in the browser close inside `checkTarget`, before any `builds` row runs, with no `builds` row in its output | `/tmp/retest-builds-lane/integration-m2-doctor.log`, `-2.log` |
| `npm run test:unit` | 2807 of 2810. The three failures are the two known `playwright-resolve` cases and `tests/unit/webkit-target-session.test.ts`, a WebKit lane file still being written, which hung for 11 minutes until I ended that test process, which my own run had started. `runner-target-drivers.test.ts` passed in this run | `/tmp/retest-builds-lane/unit-all-2.log`; an earlier run, `unit-all-1.log`: 2770 of 2773, failing a load-dependent `diagnostics-run` case that passes alone and the two known `playwright-resolve` cases |
| `retest install --list`, `--list --verify --json`, `install webdriveragent mac2`, `install webkit chromium firefox` on this Mac's real cache | exit 0, 0, 0, 2; no download | `/tmp/retest-builds-lane/real-list.txt`, `real-list-verify.json`, `real-executors.txt`, `real-refusals.txt` |
| one-off read-only script holding the Playwright, Electron and `/Applications` copies against the pins | every pinned executable and file matches; WebKit lacks the nine required notices | `/tmp/retest-builds-lane/real-caches.log` |

No benchmark ran. Each `pgrep -f benchmarks/run.ts` hit was another session's shell whose command text contains that phrase, and no node process ran it. Heavy gates ran only through `lockf`; a busy lock was retried a minute later.

## The pin table

| Engine | Version or build | Platform | Archive SHA-256 | Licence files expected | Install |
| --- | --- | --- | --- | --- | --- |
| chromium | Chrome for Testing 153.0.8010.12 | macOS arm64 | not pinned | `chrome-mac-arm64/ABOUT`, Widevine `LICENSE` | refused: no checksum |
| chromium | Chrome for Testing 153.0.8010.12 | Linux x64 | not pinned | not inspected | refused: notices never inspected |
| firefox | 133.0.3, build 20241209150345 (Mozilla disk image) | macOS arm64 | not pinned | `Firefox.app/Contents/Resources/omni.ja`, which holds about:license | refused: no checksum |
| webkit | Playwright build 2359 (WebKit 26.6) | macOS arm64 | not pinned | four Web Inspector licences, plus nine WebKit notices under `licenses/` that the published build lacks | refused: names the nine files |
| electron | 44.5.1 | macOS arm64 | `1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c` | `LICENSE`, `LICENSES.chromium.html` | installs |
| webdriveragent | 16.13.6 at `9d1d17dd…`, Xcode 17F42 | macOS arm64 | built from source | three files under `licenses/` | builds from the runner's checkout |
| mac2 | 4.3.6 at `f3825719…`, Xcode 17F42 | macOS arm64 | built from source | four files under `licenses/` | builds from the runner's checkout |

The sources, every file checksum and where each fact was read are in `proofs/builds.md`.

## What could not be verified, most important first

1. No download from any publisher: none was allowed. Chrome for Testing, Firefox and WebKit therefore have no archive checksum, and `retest install` refuses them. Pinning each needs one download to take the checksum.
2. WebKit's licence notices await the founder. Retest has no copy of the nine files, so WebKit stays refused even with a checksum.
3. The Firefox lane's `src/browser/firefox/executable.ts` tells a user with no Firefox to "Install the pinned build with retest install firefox". That command refuses Firefox until its checksum is pinned. Their message and my refusal disagree.
4. `tests/unit/runner-target-drivers.test.ts` moves as the driver lanes wire their drivers. It failed 8 cases after the Firefox wiring, passed in the full unit run once the Firefox lane updated it, and failed 8 again on my last run, after the WebKit driver was wired, since it still expects WebKit refused. The file and those changes are not this lane's. No `builds` row appears in those cases, since they give no `HOME`.
5. `tests/integration/m2-doctor.test.ts`: the Chrome for Testing close failure above. Its cause was not established; the process-ownership code is outside this lane.
6. `doctor` refuses native targets as having no driver, because `checkTarget` calls `targetDriver` without the native option. That is older than this lane and outside it, so the executors get no `doctor` row. `retest install --list` shows them.
7. A native run still builds an executor itself when none is recorded (`src/runner/native-pool.ts`). Only downloads are ruled out on run.
8. Linux x64 never ran. The Firefox disk-image install ran only on a stand-in image. A fresh executor build through `retest install` was not run, because both builds were already recorded here.
9. The WebKit driver lane looks only at `executablePath` and `RETEST_WEBKIT_BUILD`. A WebKit build installed by Retest would be used only when one of them names it, and the doctor rows say exactly that.

## Every existing file changed

- `src/cli/cli.ts`: one import, and `installCommand` in the `commands` list.
- `src/cli/doctor/checks.ts`: one import of `checkBuilds`, and one line in `runChecks`. Nothing else; the Firefox lane's later edits to the file are theirs.
- `tests/unit/cli-help.test.ts`: the two exact lists of command names now include `install`, since the command exists. Both assertions still check the whole list.
- `docs/guide.md`:
  - the intro sentence and the browser prerequisite
  - a new "Pinned browser builds" subsection under "Install and build"
  - a `builds` bullet under "Check the setup"
  - the `retest install` line under "What Retest does not do yet"

No dependency, `package.json` or script change. The one new environment variable is `RETEST_DOWNLOAD_MIRROR`, which the command implements. Scratch files are under `/tmp/retest-builds-lane/`: the logs, the replace helper, the lock retry wrapper, and the one-off inspection script. Nothing was committed.
