# Media pins refresh

The manifest and aggregate source pins now match the shipped crate. The baseline reproduced the four reported failures. After refresh, the requested unit files passed 22/22 and the unchanged packaged installation test passed 4/4 through the shared lock. Every test run had zero cancelled, skipped or todo tests. No existing assertion changed.

Only `src/cli/install/media-pins.ts`, `tests/unit/media-install.test.ts`, `docs/plans/public-beta/proofs/media-install.md` and this report were edited in the repository. The pin file changes two computed hashes. The unit file adds one older-source cache regression. The proof records the current identity, recomputation procedure, cache semantics and new verification. The other worker's evidence files were left alone.

The required README, architecture, common rules, phase decisions, client/runner report's final limits, Firefox recording report and installer report/proof were read before implementation. The unslop writing skill was applied to this report and the proof update.

The reviewed manifest differs from the previously pinned bytes only by the Firefox fix's `[profile.dev]` block with `opt-level = 1`. Removing that exact block reconstructs the old pinned manifest hash. Parsed comparison confirms unchanged dependencies, release profile and Rust minimum. The release profile remains `lto = true`, `codegen-units = 1`, `strip = true`; the manifest requires Rust 1.88 and the installer still pins 1.88.0. All 20 other pinned files, including Cargo.lock, match their previous pins.

| Identity | SHA-256 |
| --- | --- |
| Previous Cargo.toml | `387a68654f8b08411b08e8e9dbde849075c0d8326fd5919d8ad232a55f55b242` |
| Current Cargo.toml | `7d68b73873840d3968ba354b1d010186ef1df4b96ecdcc5a7b6a74e4696efbf4` |
| Unchanged Cargo.lock | `ded3cee3c32d990f089b0e4fba70222b200d386482869dff46d9987854451ed5` |
| Previous aggregate in the current pin file | `d019a1d4b336806c2a0609333339bcd5b993d0a3ef71fe0ca41902c875fff171` |
| Refreshed aggregate | `99566ae793c7250c1422e58f36d88acd08b2390f162ea0a653224c7e362fe15f` |

Refresh used the original install lane's `/tmp/retest-media-install-logs/generate-notices.py`, SHA-256 `0d865a24356cb329146fe285b1f6de53dbb819e0529810b4af5f096c7764b77d`. `/tmp/retest-media-pins-refresh/refresh.py` copied the 21 pinned files to a disposable root, ran that generator there using cached crate licences, confirmed identical notices and the unchanged allowlist, independently checked its computed hashes, and transferred only the computed Cargo.toml hash and aggregate digest. The older generator's full template lacks the later file-size limit declarations; running it in a copy preserved those declarations in the current file. No hash was invented or edited without recomputation. The temporary root was removed.

The aggregate is SHA-256 over the allowlist's ordered `path + NUL + file SHA-256 + newline` entries. `manifest-review.json` records the manifest/dependency/profile review and generator identity. `media-pins-before.ts` retains the pre-refresh pin file. `proof-digest.log` independently reproduces all 21 file hashes and the new aggregate using the read-only command now recorded in the proof.

Commands below ran from `/Users/dragon/Documents/Projects/Gruvi/Products/retest`. Logs and helpers are under `/tmp/retest-media-pins-refresh/`. `gate.mjs` runs `pgrep -f benchmarks/run.ts` immediately before starting each command and refuses a match or an unreadable precheck. Every precheck returned 1 with no matches. It captures command output, exact argv, exit status, counts and observed PID/start/command-hash identities in the named log and its `.result.json` and `.owners.json` files. The packaged gate acquired the shared lock on its first attempt; there were no busy attempts or retries.

| Check | Result | Output log |
| --- | --- | --- |
| Baseline requested unit files | Exit 1; 21 tests, 17 passed, 4 failed | `/tmp/retest-media-pins-refresh/units-before.log` |
| Refreshed requested unit files | Exit 0; 22 tests, 22 passed, 0 failed | `/tmp/retest-media-pins-refresh/units-after.log` |
| Packaged installation through lock | Exit 0; 4 tests, 4 passed, 0 failed | `/tmp/retest-media-pins-refresh/install-media-1.log` |
| Real-cache verified JSON list before refresh | Exit 0; media missing | `/tmp/retest-media-pins-refresh/cache-before-list.json` |
| Real-cache verified JSON list after refresh | Exit 0; media missing, refreshed digest | `/tmp/retest-media-pins-refresh/cache-after-list.json` |
| Real-cache text list after refresh | Exit 0; media missing | `/tmp/retest-media-pins-refresh/cache-after-list-text.log` |
| Final source/package/process audit | Exit 0; 21 pins checked, 261 recorded process identities, 0 still matching | `/tmp/retest-media-pins-refresh/audit.log`, `/tmp/retest-media-pins-refresh/audit.json` |
| Scoped whitespace check | Exit 0, no output | `/tmp/retest-media-pins-refresh/diff-check-final.log` |

Exact test and inspection commands:

```sh
node /tmp/retest-media-pins-refresh/gate.mjs /tmp/retest-media-pins-refresh/units-before.log node --conditions=retest-source --test --test-concurrency=1 tests/unit/media-install.test.ts tests/unit/media-locate.test.ts
node /tmp/retest-media-pins-refresh/gate.mjs /tmp/retest-media-pins-refresh/cache-before-list.json node --conditions=retest-source src/cli/main.ts install --list --verify --json
node /tmp/retest-media-pins-refresh/gate.mjs /tmp/retest-media-pins-refresh/units-after.log node --conditions=retest-source --test --test-concurrency=1 tests/unit/media-install.test.ts tests/unit/media-locate.test.ts
lockf -t 0 /tmp/retest-heavy-gate.lock node /tmp/retest-media-pins-refresh/gate.mjs /tmp/retest-media-pins-refresh/install-media-1.log node --conditions=retest-source --test --test-concurrency=1 tests/integration/install-media.test.ts > /tmp/retest-media-pins-refresh/install-media-attempt-1.log 2>&1
node /tmp/retest-media-pins-refresh/gate.mjs /tmp/retest-media-pins-refresh/cache-after-list.json node --conditions=retest-source src/cli/main.ts install --list --verify --json
node /tmp/retest-media-pins-refresh/gate.mjs /tmp/retest-media-pins-refresh/cache-after-list-text.log node --conditions=retest-source src/cli/main.ts install --list
```

Exact refresh and final audit commands:

```sh
python3 /tmp/retest-media-pins-refresh/refresh.py > /tmp/retest-media-pins-refresh/refresh-success.log 2>&1
python3 /tmp/retest-media-pins-refresh/audit.py > /tmp/retest-media-pins-refresh/audit.log 2>&1
git diff --check -- src/cli/install/media-pins.ts tests/unit/media-install.test.ts docs/plans/public-beta/proofs/media-install.md docs/plans/public-beta/codex/phase-4/media-pins-refresh-report.md > /tmp/retest-media-pins-refresh/diff-check-final.log 2>&1
```

The first refresh helper invocation, `python3 /tmp/retest-media-pins-refresh/refresh.py > /tmp/retest-media-pins-refresh/refresh.log 2>&1`, exited 1 because its cache snapshot assumed the media folder existed. It stopped before generation or repository edits. The helper was corrected to record an absent folder, then the successful command above ran. Both logs are retained. The earlier scoped whitespace check also exited 0 in `diff-check-initial.log`.

The packaged test compiled the production CLI with the existing TypeScript build configuration, packed/unpacked it offline, and built only the shipped crate with cached locked dependencies into a fresh target and temporary cache. The recorded build has version 0.1.0, protocol 2, target `aarch64-apple-darwin`, rustc 1.98.1 and binary SHA-256 `c1314cb30923e23b56f9a718a38454d1072250ba4569ec6eb988d0dd4846273f`. It verified discovery, listing/reuse, doctor with ffmpeg 9.0.2 and released generation-lock markers. The same four cases retained the exact pinned localhost stand-in, wrong-checksum refusal, changed-lock refusal, missing-Cargo refusal, unusable-encoder result, damaged-cache refusal and wrong version/protocol/target probe failures. The stand-in transferred only the test's just-built binary over 127.0.0.1. No external artifact, crate or npm package was downloaded.

The supported inspection syntax is `install --list`, with no engine positional argument. Both real-cache forms above answered read-only. Media is absent at `/Users/dragon/Library/Caches/retest/media/media-0.1.0-aarch64-apple-darwin` before and after refresh, recorded in `cache-before-files.json` and `cache-verification.json`. No already installed media build on this real cache became damaged because none was present.

An installation carrying the earlier digest is intentionally reported `damaged`, even if its binary and notices are intact. The new unit case begins with a valid fully verified fixture, changes only the recorded source digest to the previous pin, and requires damaged inspection, refused installation before any build-tool command, refused discovery, unchanged record and binary bytes, and unchanged folder entries. This follows the proof's strict source-identity contract. A rebuilt crate is a new build; the label means its record does not match current shipped source, not proven binary corruption. This task neither rewrote a real cache record nor rebuilt a real-cache installation.

The final audit found the generator staging root and packaged fixture root absent and no matching recorded process identity. All tool sessions completed. No owned process remains running. No benchmark, commit, push, stash, checkout, reset, revert, publication or ownership change ran, and no foreign process was signalled.

Whole-tree unit/integration/typecheck, TypeScript 7, real browser/native recording, Linux x64, Rust 1.88 itself, a cold Cargo cache and public prebuilt installation were not verified by this task. The packaged production compilation and the named macOS arm64 installer gates are the current evidence. The proof retains earlier installer results as historical evidence and records that this packed-copy pass supersedes the original compile blocker on this host.
