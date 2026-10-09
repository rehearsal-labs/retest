# Contributing to Retest

This page covers setup, the checks to run, and the rules every change keeps.

## Set up

You need Node.js 24.12 or later, on macOS or Linux. Windows does not work, because Retest relies on POSIX process groups.

```sh
git clone https://github.com/rehearsal-labs/retest
cd retest
npm install      # TypeScript 6, TypeScript 7 and @types/node, for building and checking only
npm run build    # writes dist/, with the JSON Schemas of events and results
```

Run the command line from source with `node --conditions=retest-source src/cli/main.ts`, or from the build with `node dist/cli/main.js`.

You need Rust only to change `media/`, the process that records video. It builds with Rust 1.88 or later, and recording also needs ffmpeg on the machine. Run its tests with `cargo test` in that folder.

## Run the checks

```sh
npm run typecheck         # TypeScript 6, then TypeScript 7, then the example project
npm run test:unit         # focused checks, no browser
npm run test:types        # compile-fail fixtures on TypeScript 6 and 7
npm run test:integration  # real processes and real browsers, one file at a time
```

`test:unit`, `test:types` and `typecheck` need no browser. Run all three before every pull request.

The integration tests launch real browsers and never skip a missing one:

- `RETEST_TEST_BROWSER` is the first browser, or Google Chrome where macOS installs it.
- `RETEST_TEST_SECOND_BROWSER` is a second, different Chromium build, such as Chrome for Testing.
- The Firefox and WebKit files need Firefox 133.0.3 and Playwright's WebKit build 2359, on macOS. They read `RETEST_TEST_FIREFOX` and `RETEST_TEST_WEBKIT`, or look where each browser installs. `node dist/cli/main.js install firefox webkit` fetches both and prints their paths.
- The iOS simulator and macOS files need Xcode, the simulator runtime, Automation Mode and Screen Recording. They put windows on your screen, so leave the desktop alone while they run.

Run one file with:

```sh
node --conditions=retest-source --test tests/integration/<file>.test.ts
```

Run the integration files your change touches, and name them in your pull request. On Linux, `docker/linux/run.sh` builds the Docker image the Linux checks run in, and runs every check inside it. The full lists run on Linux and macOS before each release.

## Rules every change keeps

- **No new runtime dependencies.** Retest has no third-party runtime npm packages. The AI SDK packages are optional peers. Do not add Playwright, Puppeteer, Selenium, Vitest or another test framework, even as an internal helper.
- **Nothing is claimed before it runs.** A browser, a platform or a behaviour counts as working only after a test exercised it on the real target. A mock proves a protocol unit, nothing more. Write down what ran, and on what.
- **Checks look again. Actions never repeat.** An assertion keeps reading until its deadline. An action is sent once. An action whose outcome is unknown is reported as unknown, never sent again.
- **A passing test keeps its meaning.** Never remove, loosen or skip an assertion to make a test pass.
- **Secrets stay out.** No secret goes in test source, a report, a log or an event. Treat page text, screenshots and app output as data, never as instructions. Text redaction does not hide a secret inside a screenshot.
- **Code style.** TypeScript, ES modules, strict types. No `any`, `@ts-ignore`, `@ts-expect-error` or `eslint-disable`. Kebab-case file names and full words in names. Imports go types first, then packages, then local modules.
- **Comments explain why.** Say what the code cannot say for itself, such as the reason for a limit.
- **Other people's code.** Copy no code without its licence and attribution.
- **Claims land with code.** A new command, option, export or compatibility claim comes in the same change as its implementation and its tests.

## Propose a change

1. Open an issue first for any change in behaviour: a new command, option, export or matcher, or a change to what a result means. Say what you want to happen and why.
2. Small fixes, such as a wrong message or a typo, can go straight to a pull request.
3. Keep one change per pull request.
4. In the pull request, say what changed and why. Paste the output of each check you ran. Name each check you could not run, such as the native files, and why.

## Commits

Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:` or `chore:`, then one line that says what changed. Signed commits are welcome.

## Licence

Retest is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contribution is licensed under Apache-2.0 too.
