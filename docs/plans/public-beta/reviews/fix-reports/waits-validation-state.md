# Waits validation state

- Intake and source review complete; shared work preserved.
- Original focused units 39/39, browser page/process/window units 49/49, final affected sweep 72/72. Zero skips. Saved pre-sweep source fails 33/36 checks.
- Native full rerun 365/366, zero skips. Short-gap fixture now uses a controlled clock with all original stability/no-input assertions and a full-deadline bound. The remaining native-processes assertion belongs to the other worker and is untouched.
- Chrome's four shared suites and WebKit driver pass. Final Firefox driver/table/shared gate passes 176/176, zero skips. Browser-first deliberate crash passes the unchanged real loss and one-input assertions. Affected process units pass 8/8.
- Firefox native-table regression passes 1/1 after failing first at the blanket row refusal. All team row texts/cells/header/table assertions pass; layout-cue fixtures keep exact refusals. Live role comparison has 23,733 lookups and zero silent differences. Named-cell refusal remains, and F8.1a declares that later exact outcome.
- Firefox conformance passes once, exit 0, 148/148 cases, 15/15 run groups, 164/164 Node checks, zero skips. Artifacts: `/tmp/retest-waits-validation-conformance.Ly09od`.
- Packaged media rerun passes 4/4, exit 0, zero skips. Fresh offline packed-source build, protocol 2, cache discovery/reuse, pinned localhost stand-in and refusal/cleanup cases all pass. Only the stale source pin and aggregate digest needed correction.
- First typecheck exits 2 on this lane's new test fixture type. Added the actual FirefoxPage instance assertion before dispatch; affected unit cases pass 2/2. No production source changed after green integrations.
- npm run typecheck and npm run typecheck:proofs pass, exit 0. Both main-tree compilers, the example project and all eight proof/project compiler checks finish.
- Final owned-process audit: exit 0, 227 recorded identities, zero live owned processes, zero changed-command candidates. Final media inventory: all 21 hashes match. No heavy command is queued or running. Assigned work is complete; native units retain the one outside-lane assertion failure recorded above.
- Proof and guide describe the narrowed table policy; declaration units pass 21/21. Packaged failing-first run compiles/packs and fails 1/4 at the stale jobs.rs pin. Refreshed that pin and aggregate digest only. Media unit rerun passes 17/17, zero skips; post-refresh inventory records every allowlist hash matching.
- Exact commands/counts are in waits-validation-report.md. Logs are `.retest/scratch-waits-validation/logs/`. Process identities are in `processes.log` and `descendants.jsonl` under that scratch folder.
- No commit, stash, reset, revert, benchmark or download. No compatibility claim for other hosts, native devices or Firefox's default spawn route.
