# Media review fixes

The second-read findings 1, 7, 8, 10 and 11 are fixed in the Rust media process. The incremental [fix report](../codex/phase-4/fix-media-crate-report.md) contains failing-first logs, failed fixture attempts, exact commands and gate results. The [client contract](../codex/phase-4/media-client-v2.md) records the additive fields and reader compatibility.

- Capture-gap overflow has a conservative omitted-detail count in interval replies. Evaluation treats that count as missing evidence.
- A supervised child of the same media binary performs file finalization within the remaining finish budget. A timeout names the possible partial and publication uncertainty and cannot become ok.
- Reply admission and writer shutdown are bounded. Dropped normal replies are counted, blocked stdout is named through versioned stderr, and lost replies make the process exit 2. The separate stdout descriptor is atomically close-on-exec; an unchanged client test exposed its initial descriptor leak and the report preserves that failure.
- Unsupported exclusive rename uses link-then-unlink. If both operations are unsupported, placement fails rather than overwrite a foreign file.
- Matching-format images are decoded before thumbnail/live pass-through. Invalid images are refused and named.

Three offline whole-crate runs passed with 92 unit and 54 process tests each. The regressions exercise the real media binary and a fake encoder, including an actual unread stdout pipe and stdin EOF. The foreign-writer race uses a barrier and an injected unsupported-rename result. Slow/stuck finalization uses a debug-only hook. Evaluation and protocol regressions use stand-in evidence and check that missing evidence cannot become a presence pass.

Scoped TypeScript 6 and 7 and all-target clippy with warnings denied passed. The offline release build completed. The final media/evaluation unit set passed 169 tests against the refreshed installer pins after the discovery builder corrected its existing path mismatch without changing that assertion. The real TypeScript media-client gate passed all 32 unchanged tests through the shared lock, including both encoder cleanup cases that exposed the descriptor leak. Final gate logs and binary/source hashes are in the report.

Run the Rust checks with Homebrew Cargo and rustc named explicitly and --locked --offline, as recorded in the report. The clippy command names cargo-clippy, CARGO, RUSTC and RUSTC_WORKSPACE_WRAPPER explicitly. The real client gate uses lockf -t 0 /tmp/retest-heavy-gate.lock. Every test checks for an active benchmarks/run.ts first; no benchmark ran.

Linux, the minimum Rust version, a real stuck kernel/filesystem syscall, and a real filesystem without exclusive rename or hard links were not exercised. This record makes no native capture, release, install or playback claim. A dispatched filesystem operation can have an unknown outcome after timeout; cancellation does not establish that it was undone.
