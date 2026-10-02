# Benchmarks

The harness behind `docs/plans/speed/plan.md`. It runs the same generated tests through Retest and Playwright, against the same fixture app and the same Chrome, and writes per-phase medians. Every speed number the project publishes comes from here, with the command that produced it.

```sh
npm run bench                      # the whole matrix, five runs per cell
npm run bench -- --sizes 1,20 --runs 3 --fixtures task-app
```

## What it does

1. Builds Retest, packs it with `npm pack`, and installs the tarball offline into a project outside the repository.
2. Installs `@playwright/test` into a second project outside the repository. `latest` is asked of the registry on every run, and the project is reinstalled whenever its version is not the one asked for, or on `--reinstall`. Playwright is never a dependency of this package, and its browsers are never downloaded: both tools run the Chrome you point them at.
3. Starts a fixture app from this checkout, writes both tools' configs for its address, generates the test files, and runs each cell `--runs` times, interleaving the runners so no tool gets a cold machine or a warm one alone.
4. Writes `results.json` and `results.md` under `.retest/benchmarks/<time>/`, with every run's own output beside them under `runs/`. The results name the commit the package was packed from, whether the working tree was clean, and whether dist was rebuilt, so a number can always be tied to the code it measured. The output folder must not hold files yet, because Retest never writes over a run.

A run that passes `--run-timeout-ms` is ended with every process it started, browsers included, and its cell says `timed out`. The fixture servers are ended whenever the harness exits, Ctrl+C included. `node benchmarks/run.ts --help` lists every flag.

## Fixtures

| Fixture | Stands for |
| --- | --- |
| `task-app` | Runner-dominated. The page answers at once, so the runner's own time is most of a test |
| `search-app` | App-dominated. A 150 ms API and a 300 ms debounce, so the app's waiting is most of a test |

## Phases

Both tools are read the same way: Retest from its `events.jsonl`, Playwright from its JSON reporter.

| Phase | From | To |
| --- | --- | --- |
| Wall | spawning the process | the process exiting |
| Startup | spawning the process | the first test starting |
| Tests | the first test starting | the last test ending |
| Teardown | the last test ending | the process exiting |
| Per test | the median of what the tool reports for one test | |

A run is valid only when every expected test passed and the process exited 0. Medians read valid runs alone, and the table says how many of the runs were valid. A cell with no valid run prints the reasons instead of numbers; nothing is dropped quietly.

## Rules

From the plan's methodology section.

- Both fixtures are always published together.
- Both tools run on their defaults. A Playwright row with one worker is the like-for-like comparison for a single file, and the default-workers row is what a user gets.
- The row "Retest, on Playwright's own spec files" runs the Playwright project's files unchanged through `retest run --playwright`, so the two tools are compared on the very same files.
- The rows where Retest is slower stay in.
- Never compared to Vitest. It is a unit runner.
