# Explicit media installation and discovery

The media installer builds the shipped crate from a pinned allowlist, with Cargo.lock unchanged, and puts a checked release binary in Retest's cache. It uses the current installer generation lock, including machine identity and refusal of an unreadable holder. It ships no ffmpeg. No public media artifact has been downloaded or pinned.

Source identity is SHA-256 `99566ae793c7250c1422e58f36d88acd08b2390f162ea0a653224c7e362fe15f`. The pin covers Cargo.toml, Cargo.lock, build.rs, the Rust source files, Retest's licence and generated third-party notices. The crate version is 0.1.0, its protocol is 2 and its minimum Rust version is 1.88. Edition 2024 alone needs Rust 1.85, but that does not meet the pinned crate's requirement.

## Implementation

- `src/cli/install/media-install.ts` builds with `--release --locked`, and `--offline` when requested, from a copied and checked source allowlist in fresh staging and target folders. It compares the lock and sources before and after the build, checks the release greeting, copies notices and writes the record before renaming the folder into place. It reuses a valid installation and refuses a damaged folder by name.
- `src/cli/install/media-record.ts` checks source identity and cache records. Every record goes through `src/shared/regular-file.ts`'s bounded reader. Binary and notice hashes use its checked descriptor reader. Unknown record fields, mismatched versions, protocols, source digests, target triples, Rust versions, binary hashes, notice hashes and unsafe modes are refusals. Full verification also refuses unrecorded entries.
- `src/cli/install/media-pins.ts` pins the source and target paths. Its prebuilt table is empty. A prebuilt install is allowed only with an exact pin for its version, protocol, source digest, target, size and binary SHA-256. Both a local file and a mirror use the same checks. The stand-in pin used by a test is never part of the production table.
- `src/cli/install/media-tools.ts` finds build tools, rejects unsupported Rust versions and uses the process's own greeting and readiness probe. Toolchain and ffmpeg listing commands inherit only host tool paths. Probes close their own media process and refuse unconfirmed cleanup.
- `src/media/locate.ts` resolves the explicit executable setting, then RETEST_MEDIA_BINARY, then the checked cache. It never searches Cargo targets. It rejects unusable settings, damaged cache records and wrong binary identity. ffmpeg is explicit, then RETEST_FFMPEG, then PATH. An explicit but unusable setting does not fall through.
- `src/cli/install/media-doctor.ts` adds rows when the config requests recording. The media row states its source, version, protocol and recorded checksum. Cargo and rustc rows state their versions and requirements when a build is needed. ffmpeg's row states its path, version, licence and the raw or encoded input, codec and muxer requirements. Its own media probe decides availability.
- `src/cli/install/media-report.ts` adds media to the existing install list document and terminal output. The list reads files only. The media cache record has its own schemaVersion 1. No run-folder event or schema changed.
- `src/cli/install/media-notices.txt` was generated from Cargo.lock and the cached crates' licence files. It names every registry crate, version and package checksum, with licence texts. Retest's LICENSE and those notices are copied beside the installed binary.

The package files allowlist now carries the crate manifest, lock, build script and Rust sources, LICENSE and third-party notices alongside dist. There is no npm dependency, install script or automatic build. Packaging as platform binaries or optional platform packages remains open.

## Commands

```sh
npx retest install media
npx retest install media --offline
npx retest install --list --verify --json
npx retest install media --media-binary /absolute/path/retest-media
npx retest install media --media-mirror https://mirror.example.com
```

The last two refuse before reading or downloading a prebuilt because none has a production checksum pin. Offline source installation needs the locked crates already cached; the package does not vendor them. Normal source installation may let Cargo fetch the crates selected by the lock. ffmpeg is a declared prerequisite, installed by the host, with no download by Retest. Its licence depends on its build; the host build exercised by the media proof reports GNU GPL version 3 or later.

The original installer handoff asked the recording runner to call this lane's discovery. That handoff is first in `../codex/phase-4/media-install-report.md`. The pin refresh does not reverify recording-runner behavior.

## Source pin refresh and cache identity

The Firefox recording fix adds only `[profile.dev] opt-level = 1` to the previously pinned manifest. Removing that exact block reconstructs the previous manifest SHA-256 `387a68654f8b08411b08e8e9dbde849075c0d8326fd5919d8ad232a55f55b242`. The current manifest hashes to `7d68b73873840d3968ba354b1d010186ef1df4b96ecdcc5a7b6a74e4696efbf4`. Release settings remain `lto = true`, `codegen-units = 1`, `strip = true`. Dependencies and the Rust minimum are unchanged. Cargo.lock remains SHA-256 `ded3cee3c32d990f089b0e4fba70222b200d386482869dff46d9987854451ed5`.

The recorded installer generator is `/tmp/retest-media-install-logs/generate-notices.py`. The refresh ran it in a disposable copy of all 21 pinned files. It regenerated identical notices from cached crate licence files and recomputed every source hash. Only Cargo.toml differed. The refresh copied the computed manifest hash and aggregate digest into the current pin file, preserving its limits, allowlist, Rust minimum and empty prebuilt table. Running the older generator directly over the current pin file would remove later limit declarations, so use a disposable copy and transfer only reviewed computed pins.

The aggregate hash uses the allowlist's order. For each file it hashes its exact bytes, then adds `path`, a NUL byte, the lowercase file SHA-256 and a newline to the aggregate SHA-256. This read-only command reproduces that computation from the current allowlist without trusting its stored file hashes:

```sh
python3 - <<'PY'
import hashlib, pathlib, re
root = pathlib.Path.cwd()
pins = (root / 'src/cli/install/media-pins.ts').read_text()
paths = re.findall(r"\{ path: '([^']+)', sha256: '[a-f0-9]{64}' \}", pins)
assert paths
aggregate = hashlib.sha256()
for path in paths:
    digest = hashlib.sha256((root / path).read_bytes()).hexdigest()
    aggregate.update((path + '\0' + digest + '\n').encode())
    print(path, digest)
print('source digest', aggregate.hexdigest())
PY
```

A rebuilt crate has a new source identity even when its version, protocol and release settings stay the same. Inspection intentionally reports an installation with a different recorded source digest as `damaged`. Here that means the build record does not match the shipped source, not that Retest proved binary corruption. Installation and discovery refuse that folder and leave it untouched. Neither reuse of an older record nor rewriting its digest establishes a build of the new crate.

The refreshed unit gates passed 22/22, including the four previously failing checks with their assertions unchanged and a new intact-cache regression for the previous source digest. The unchanged packaged install gate passed 4/4 under the shared lock. It compiled and packed the CLI, built the packed crate offline into a fresh target/cache with rustc 1.98.1 on macOS arm64, checked protocol 2 and the current source digest, verified listing/reuse and doctor, checked the released generation lock, and retained the local stand-in checksum and refusal cases. No test was cancelled, skipped or marked todo. This supersedes the earlier packed-copy compile blocker on this host.

Read-only source CLI commands `install --list` and `install --list --verify --json` both exited 0 against this Mac's real cache. Media was `missing` before and after the refresh at `/Users/dragon/Library/Caches/retest/media/media-0.1.0-aarch64-apple-darwin`. No existing real-cache media build became damaged here because none was installed. The unit regression proves the older-record refusal in a temporary fixture; the real cache was not installed into or changed.

Exact commands, counts and logs are in [the refresh report](../codex/phase-4/media-pins-refresh-report.md). Logs are under `/tmp/retest-media-pins-refresh/`. Linux x64, a Rust 1.88 build, a cold Cargo cache and a public prebuilt remain unverified. No benchmark or external download ran.

## Earlier installer verification

Logs are in `/tmp/retest-media-install-logs/`. Lane and registration units passed all 44 tests with no skips or cancellation. Both type-fixture compilers matched all 236 expected errors. The full unit suite had 3715 passes and 20 failures outside this lane. The final whole-tree TypeScript 6 and 7 checks reported outside-lane inspect and recording-fake errors; examples passed. Exact commands and logs are in the report.

The source fixture `source-proof.ts` passed under the heavy gate in `source-proof-3.log`. It copied the pinned source files to a temporary root, built them offline with Homebrew rustc 1.98.1 into fresh staging, target and cache folders, and verified version 0.1.0, protocol 2 and target aarch64-apple-darwin. Its binary was 1,365,088 bytes. Its record carried SHA-256 `5901ac28e251bc79e66ba6a350e63b49a3c05eb5b382a504c0e589f13062fd99`. That is this local build's checksum, not a published prebuilt pin. Discovery and doctor passed with ffmpeg 9.0.2, whose own probe chose libx264 in MP4 and reported PNG and JPEG inputs. Both declared codec and muxer routes were present. The false encoder was reported as failed. The fixture served only its just-built binary on 127.0.0.1, installed it with an injected exact pin, refused a wrong checksum and refused production inspection of that unpinned prebuilt. All temporary folders and the server were closed by its hooks.

The final fixture passed in `source-final-18.log` after 17 busy-lock refusals. It retained that source and stand-in proof, with the same local binary checksum, and added source CLI reuse and JSON verification with exit 0, unpinned prebuilt CLI refusal with exit 2, explicit binary use without Cargo or rustc, checksum reporting for an explicit cache path, and named refusal of wrong version, protocol, target and damaged cache. Doctor included the GPL version 3 or later licence paragraph. All 44 lane and registration units passed in `unit-final-9.log`. The latest TypeScript 6 and 7 checks still named only outside-lane errors; examples passed. All owned commands and retry scripts ended and the fixture's server and temporary folders were cleaned up.

The prescribed packed-copy integration acquired the gate at attempt 8 and failed in its compile hook. `src/cli/inspect/test-timeline.ts` lacks a return path; no installer case reached execution. Its clean compilation assertion remains intact. Therefore the npm-packed CLI build and install remain unverified, even though the independent source installer passed. The runner still needs the discovery handoff at the top of the report.

The Linux x64 command acquired the gate and exited 125 in `linux-x64-2.log`. Docker refused the installed arm64 image for the requested amd64 platform before starting a container. No image was pulled and Linux x64 is unverified. A Rust 1.88 build, cold Cargo cache and public publisher path remain unverified. No external artifact, crate or npm package was downloaded. The fixture transferred only its own stand-in over 127.0.0.1. No benchmark ran.
