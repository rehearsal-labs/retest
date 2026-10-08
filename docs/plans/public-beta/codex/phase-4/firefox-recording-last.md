The cause was the unoptimized debug build’s resize backlog for Firefox’s larger PNGs. Enabled development-profile optimization and added a failing-first regression. Deadlines and assertions remain unchanged.

Passed under the lock: Firefox 5/5, Chrome 7/7, WebKit 5/5. Rust passed 147 tests; clippy passed. No owned processes remain.

Evidence, exact commands, logs and verification limits are in [firefox-recording-report.md](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/codex/phase-4/firefox-recording-report.md).