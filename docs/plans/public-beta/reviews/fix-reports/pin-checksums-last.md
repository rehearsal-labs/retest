Recorded checksums, comparisons, commands and logs in [pin-checksums-report.md](/Users/dragon/Documents/Projects/Gruvi/Products/retest/docs/plans/public-beta/reviews/fix-reports/pin-checksums-report.md).

- All six archives matched existing applicable pins and were deleted. Containers and downloaded images were removed.
- Mac install/list/verify/doctor commands passed, but current WebKit output shows **0 of 9 required notices**.
- Linux release build passed. Requested Node tests: **28 passed, one macOS-only skip**.
- Rust tests retained failures: **one codec case and four process cases**.
- Typecheck and 101 builds unit tests passed.

No commit was made.