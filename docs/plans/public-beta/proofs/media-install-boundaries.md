# Media install boundaries

Findings 6, 5, 9 and 10 from the Phase 4 second read are implemented. The incremental [fix report](../codex/phase-4/fix-install-media-env-report.md) records each reproduction, exact commands, results, fixture corrections and logs.

RunSession excludes its declared secret and judge variables from the environment passed to media startup. MediaProcess accepts that explicit environment and uses only PATH, TMPDIR and a fixed locale by default. Rust clears ffmpeg's environment and supplies those same encoder prerequisites. The Node regression observes a real stand-in child's environment. The Rust regression uses an encoder that prints a synthetic fixture environment.

Hash results carry device and inode from the opened descriptor. Exact integer identities are compared during inspection and rechecked before discovery returns its execution path. A regular executable replaced between hashing and inspection reads as damaged, with its path named. A replacement before discovery's answer is refused too. A later pathname replacement after the final check is still a race, not an atomic descriptor execution guarantee.

The installer, doctor and live runner share one greeting check for the pinned media version, host target and release profile. A refused live process closes before encoder readiness and emits no media.started event. Recording evidence remains separate from the application's outcome.

The pin limits a binary to 64 MiB and each source or notice file to 1 MiB. Hashing fixes the opening size and refuses growth, caller cancellation and an exhausted monotonic budget. Discovery bounds inspection, and run interruption or media close cancels discovery before starting further media work.

The selected regressions passed after reproducing the failures. The final locked rerun passed both scoped strict compilers (TypeScript 6.0.3 and 7.0.2), 54 unit tests, 92 Rust unit tests and 54 Rust process tests, all-target clippy with warnings denied, the offline release build, all 32 real media client tests and all 4 packaged install tests. No test was skipped. Exact commands and per-gate logs are in the fix report; the final logs have the prefix `/tmp/retest-install-media-env-` and suffix `-close.log`. The packed copy built offline into a fresh target and cache, verified its record, ran doctor against host ffmpeg, exercised a loopback prebuilt fixture, and refused damaged source and wrong identities by name.

The first full client gate failed two existing crash-cleanup checks because a concurrent crate change left a duplicate stdout descriptor open across encoder execution. Its owner corrected that descriptor; this lane refreshed the unchanged source manifest and reran the unchanged checks. The first packaged install gate refused that changed source by its checksum. Both failed gates remain in the fix report, separate from the rerun.

No minimum Rust, Linux, clean-host or new native-platform claim follows from these fixtures. The tests use this host's Homebrew Rust 1.98.1 and ffmpeg. The source pin audit has no mismatches, and the recorded gate/queue process audit finds no owned identity still running. No benchmark ran. No commit or external resource download was made.
