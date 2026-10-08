# Media installation report

## Required change in the recording runner

`src/runner/run-media.ts` still owns its placeholder `mediaLocation`. Replace that lookup with an awaited `locateMedia` from `src/media/locate.ts`, only when the run asks for recording. Pass the host's explicit `MediaLocation` fields, environment and setup budget. The stable signature is:

```ts
locateMedia({ executable?, ffmpeg?, env?, timeoutMs? })
// Promise<{ ok: true, executable, ffmpeg, source, hello, inspection? }
//       | { ok: false, message }>
```

Use `{ executable, ffmpeg }` from the successful answer for the existing start. Preserve a refused answer as named media setup failure and preserve the application outcome. `locateMedia` checks the greeting and closes that probe; it leaves no media process for the runner to close. Discovery needs no client signature change. Pass `installHint: 'npx retest install media'` to the runner's existing start so a later protocol mismatch names the installer. No runner or client file was edited. There is no attached agent named main in this session, so this report carries the handoff.

The current call in `src/runner/run-session.ts` is inside its synchronous constructor. Resolve in the async recording acquisition path, only for an app that requests recording, rather than placing an `await` in that constructor. The lookup expression from that file is:

```ts
import { locateMedia } from '../media/locate.ts'

const found = await locateMedia({
  ...(options.media === undefined ? {} : { executable: options.media.executable }),
  ...(options.media?.ffmpeg === undefined ? {} : { ffmpeg: options.media.ffmpeg }),
  env: process.env,
  timeoutMs: timeouts.setup,
})
const location = found.ok
  ? { executable: found.executable, ffmpeg: found.ffmpeg }
  : found.message
```

Keep the existing injected `StartMedia` test boundary and acquisition failure handling. Remove the placeholder's Cargo build hint once it has no caller. The real start should use:

```ts
MediaProcess.start({
  executable: location.executable,
  args: mediaArguments(location.ffmpeg === undefined ? {} : { ffmpeg: location.ffmpeg }),
  startTimeoutMs: timeoutMs,
  installHint: 'npx retest install media',
})
```

## Built paths

- `src/cli/install/media-pins.ts` pins version 0.1.0, protocol 2, the source digest, target triples and notices. The production prebuilt table is empty.
- `src/cli/install/media-install.ts` builds the copied shipped crate with Cargo's locked dependency selection, checks sources and lock before and after, verifies the release greeting, writes the record and atomically places the cache folder. Exactly pinned local binaries and mirrors share checksum and greeting checks. An absent prebuilt pin refuses before reading or fetching.
- `src/cli/install/media-record.ts` uses the installer's bounded regular-file readers, validates the record and checks binary and notices. Damaged and unverifiable cache folders are named and left in place. Full verification refuses additional entries.
- `src/cli/install/media-tools.ts` finds Cargo and rustc, checks the declared Rust minimum, runs toolchain and ffmpeg listing commands without test credentials in their environment, and closes every started media probe through the settled client's ownership layer.
- `src/media/locate.ts` gives settings and environment variables precedence over the checked cache, without a Cargo-target search. An unusable explicit value refuses; a symlink into a damaged cache cannot bypass its record. ffmpeg is an explicit setting, RETEST_FFMPEG or PATH.
- `src/cli/install/media-doctor.ts` reports media identity and recorded checksum, Cargo and rustc when needed, and ffmpeg's path, version, licence, encoder, decoder and muxer routes. The media readiness probe decides whether recording is possible. Both Rust minima and the host package-manager fixes are plain text.
- `src/cli/install/media-report.ts` adds media to the existing text and schemaVersion 1 install listing without changing browser verification.
- `src/cli/install/media-notices.txt` names each registry crate and checksum from Cargo.lock and includes its cached licence texts.
- `src/cli/commands/install.ts` registers media and its implemented options. `src/cli/doctor/checks.ts` adds one import and one check-list call after a fresh read. Snapshots before those edits are in the log folder.
- `package.json` adds only media source, lock, build script, licence and notice entries to `files`. This lane adds no dependency, npm install hook or export and keeps `private: true`.
- `tests/unit/media-install.test.ts`, `tests/unit/media-locate.test.ts` and `tests/integration/install-media.test.ts` cover the lane. Three existing engine-list expectations in `tests/unit/cli-install.test.ts` now include media with every earlier engine retained.
- `docs/guide.md` has the media installation section. `docs/plans/public-beta/proofs/media-install.md` records the source identity and limits. `media-install-state.md` records resumable work.

## Commands and results

All logs below are under `/tmp/retest-media-install-logs/`. `gate.sh` checks `pgrep -f benchmarks/run.ts` before every test. For a heavy command it calls `lockf -t 0 /tmp/retest-heavy-gate.lock "$@"`. For unit and type-fixture commands its `--unit` path runs without that lock, as the common rules allow. A busy lock is exit 75 and starts no command; retry scripts wait a minute before trying again. No benchmark was run.

| Exact command after the gate wrapper | Result | Log |
| --- | --- | --- |
| `node --conditions=retest-source --test tests/unit/media-install.test.ts tests/unit/media-locate.test.ts` | First 11 lane cases passed | `unit-first.log` |
| `node --conditions=retest-source --test tests/unit/media-install.test.ts tests/unit/media-locate.test.ts tests/unit/cli-install.test.ts tests/unit/cli-doctor.test.ts` | 41 passed after the three existing CLI expectations were extended. The first registration run failed those old engine lists only. | `unit-second.log`, `unit-registration-first.log` |
| `node --conditions=retest-source --test tests/unit/media-install.test.ts tests/unit/media-locate.test.ts` | 14 passed, including a rewritten Cargo.lock and a held generation lock | `unit-third.log` |
| `node --conditions=retest-source --test --test-concurrency=1 tests/unit/media-install.test.ts tests/unit/media-locate.test.ts tests/unit/cli-install.test.ts tests/unit/cli-doctor.test.ts` | 44 passed, none cancelled or skipped, including the explicit damaged-cache alias, the ffmpeg licence version and uncertain build-tool cleanup | `unit-final-9.log` |
| `npm run test:unit` | Exit 1. 3735 tests, 3715 passed, 20 failed, none cancelled or skipped. All named failures are outside this lane. | `test-unit.log` |
| `npm run test:types` | Exit 0. Both TypeScript 6.0.3 and 7.0.2 matched all 236 expected errors in ten projects. | `test-types.log` |
| `npm run typecheck` | Attempt 11 acquired the lock and exited 2 in TypeScript 6. No error named this lane's files. The npm script did not reach TypeScript 7 or examples. | `typecheck-11.log`, `typecheck-attempts.log` |
| `npm run typecheck` | Latest run after the lane's final edits exited 2. Remaining errors name test-timeline and inspect-looks only. | `typecheck-latest.log`, `compiler-latest-results.log` |
| `node_modules/typescript-7/bin/tsc -p tsconfig.json` | Exit 1. Same inspect errors and runner-recording-fakes. No lane error. | `typecheck-ts7-latest.log` |
| `node_modules/typescript/bin/tsc -p examples/tasks/tsconfig.json` | Exit 0 | `typecheck-examples-latest.log` |
| `node --conditions=retest-source --test --test-concurrency=1 tests/integration/install-media.test.ts` | Attempt 8 exited 1. All four cases failed the before hook because test-timeline prevents clean package compilation. No install case ran. | `integration-attempts.log`, `integration-8.log` |
| `node --conditions=retest-source --test --test-concurrency=1 /tmp/retest-media-install-logs/source-proof.ts` | Passed under the lock. A copied pinned crate built offline, cache discovery and doctor passed, an exact pinned localhost stand-in installed, and a wrong SHA-256 refused. This is separate from the failed packaged test. | `source-proof-3.log` |
| `node --conditions=retest-source --test --test-concurrency=1 /tmp/retest-media-install-logs/source-proof.ts` | Final fixture passed at attempt 18. It also checked source CLI exit 0 for reuse/listing and exit 2 for an unpinned binary, an explicit binary without Rust, the checksum row for an explicit cache path, and wrong-version, wrong-protocol, wrong-target and damaged-cache refusals. | `source-final-18.log`, `source-final-attempts.log` |
| `docker info --format '{{.OSType}} {{.Architecture}}'` | Docker was already running and reported Linux aarch64. | `docker-info.log` |
| `docker image inspect retest-linux:dev --format '{{.Os}} {{.Architecture}}'` | The installed image is Linux arm64. | `docker-image.log` |
| The exact `docker run` below | Exit 125 under the lock. Docker refused the platform mismatch before creating a container. | `linux-x64-2.log` |
| `node /tmp/retest-media-install-logs/stop-queued-proof.ts` | The ownership check found that the final fixture had begun. It resumed only its briefly stopped retry wrapper and ended no process. The fixture then passed and its wrapper exited 0. | `queue-stop.log`, `queue-stop.json` |

The full unit failures are in Firefox navigation, process launch and storage; native actionability, capture, input and alerts; and runner server shutdown, deadlines, native secrets, interrupted recording and resource handling. The first full typecheck also named active runner recording work, capture-ios, config-recording and engine-expectations. The latest checks name only test-timeline, inspect-looks and runner-recording-fakes. This lane changed none of those files and weakened no assertion.

## Not verified yet

1. The runner still uses the placeholder, so a recording run finding the new cache is not proven. The required edit is first in this report.
2. The prescribed packed-copy build is blocked by test-timeline's outside-lane compile error. The independent source build and local stand-in passed, but they do not establish that the npm-packed CLI builds and runs.
3. No published media artifact, public checksum, publisher address or release fetch exists for this lane to verify. The production table remains empty.
4. Linux x64 needs an image for that architecture with Rust and ffmpeg available. The installed image is arm64. The exact no-pull command below ran and Docker refused it.
5. The minimum Rust 1.88 toolchain itself is not installed for a real build. Version rejection is unit-tested. The source fixture used Homebrew rustc 1.98.1 and cached locked crates with Cargo offline; a cold Cargo registry fetch is not tested and no external download was made.
6. The full unit and typecheck gates are red outside this lane. There is no browser or native recording claim from these installer tests.

```sh
/tmp/retest-media-install-logs/gate.sh docker run --rm --pull never --platform linux/amd64 --init --cap-drop ALL --mount type=bind,src=/Users/dragon/Documents/Projects/Gruvi/Products/retest,dst=/retest,readonly --workdir /retest --env HOME=/tmp/retest-media-home --env CARGO_HOME=/tmp/retest-media-cargo retest-linux:dev sh -c 'uname -m && node --conditions=retest-source src/cli/main.ts install media --offline'
```

No commit, stash, reset, revert, publication or ownership change was made. No external artifact, crate, image or npm package was downloaded. The fixture transferred only its own stand-in over 127.0.0.1. Every owned command and retry has finished. The test hooks removed their temporary folders and closed the localhost servers; media probes and tool commands awaited their ownership cleanup. The recorded retry and compiler pids no longer exist, checked in `owned-processes-final.log`. The final temporary source root is absent. No process or container started by this lane remains running.
