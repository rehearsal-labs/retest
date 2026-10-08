# Retest benchmark

2026-10-06T14:31:11.828Z. Apple M4 Max, 14 cores, 36 GB, darwin 27.0.0 arm64. Node v24.12.0. Google Chrome 154.0.8037.98. Retest 0.0.0, Playwright 1.63.0.

Retest packed from commit b59eed5d6b4f, with uncommitted changes in the working tree, dist rebuilt first.

Runs per cell: 5. Each number is the median over the runs that passed every test. Milliseconds.

| Install | Time |
| --- | --- |
| Retest, packed tarball, offline, 0 dependencies | 587 ms |
| Playwright, from the registry, without its browsers | kept from an earlier run |

## task-app

runner-dominated: the page answers at once, so the runner sets the pace

| Tests | Files | Runner | Wall | Startup | Tests | Teardown | Per test | Valid runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | Retest | 1078 | 503 | 274 | 301 | 275 | 5 of 5 |
| 1 | 1 | Retest, on Playwright's own spec files | 1099 | 482 | 279 | 345 | 280 | 5 of 5 |
| 1 | 1 | Playwright, 1 worker | 3629 | 397 | 274 | 2969 | 274 | 5 of 5 |
| 20 | 1 | Retest | 5538 | 517 | 4710 | 316 | 232 | 5 of 5 |
| 20 | 1 | Retest, on Playwright's own spec files | 5559 | 514 | 4694 | 363 | 233 | 5 of 5 |
| 20 | 1 | Playwright, 1 worker | 6627 | 414 | 4819 | 1412 | 225 | 5 of 5 |

## search-app

app-dominated: a 150 ms API and a 300 ms debounce, so the app sets the pace

| Tests | Files | Runner | Wall | Startup | Tests | Teardown | Per test | Valid runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | Retest | 1476 | 505 | 628 | 280 | 629 | 5 of 5 |
| 1 | 1 | Retest, on Playwright's own spec files | 1413 | 500 | 622 | 270 | 623 | 5 of 5 |
| 1 | 1 | Playwright, 1 worker | 4383 | 404 | 953 | 3010 | 953 | 5 of 5 |
| 20 | 1 | Retest | 12836 | 609 | 11917 | 313 | 594 | 5 of 5 |
| 20 | 1 | Retest, on Playwright's own spec files | 12893 | 596 | 11889 | 331 | 593 | 5 of 5 |
| 20 | 1 | Playwright, 1 worker | 21095 | 427 | 18436 | 2273 | 905 | 5 of 5 |

Startup is the spawn to the first test starting. Tests is the first test starting to the last ending. Teardown is the last test ending to the process exiting. Per test is the median of what each tool reports for one test.
