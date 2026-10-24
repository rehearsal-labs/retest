# Releasing Retest

Retest is published to npm as `@rehearsal-labs/retest`. A push starts nothing. Work happens on `main`, and a release is a promotion. A person chooses a commit on `main` and a version, and runs `.github/workflows/promote.yml` by hand. Only then do the gates run on that commit and the package go to npm.

The founder publishes the first version, 0.1.0, by hand. Every later version goes through `promote.yml`, through npm trusted publishing. No npm token is stored in GitHub.

## Promote a commit

1. Choose a commit on `main`. Write down its full 40-character SHA.
2. Choose a version above every version on npm, written `X.Y.Z`. Retest publishes no prereleases.
3. Open Actions, choose Promote, run it from `main`, and enter the commit and the version.

From a terminal:

```sh
gh workflow run promote.yml --ref main -f commit=<full SHA> -f version=0.2.0
```

## What a promotion does

It runs four jobs in order. Each starts only when the one before it passed.

1. **Check the commit and the version.** The run stops here if it was started from a branch other than `main`, or if the commit is not a full SHA on `main`. It also stops if `package.json` at that commit is marked private or names another package. The version must be `X.Y.Z` and above every version npm has, and a package npm has never published counts as 0.0.0. The tag `vX.Y.Z` must not exist yet.
2. **Gates.** It calls `ci.yml` on the commit, and every Linux, macOS and Windows gate must pass. The gates are `ci.yml` as it is on `main`, and the code they check is the commit's.
3. **Publish to npm.** It checks out the commit and writes the version into `package.json` with `npm version X.Y.Z --no-git-tag-version`. It runs `npm ci` and `npm run build`, checks that `retest --version` prints the version, and runs `npm publish --provenance --access public`. npm publishes as the run's OIDC identity and signs a provenance statement that links the package to the commit. The job then writes a receipt with the name, version, tag and commit. The receipt is in the run summary and in the `release-receipt-<attempt>` artifact, kept for 90 days.
4. **Tag and release.** It waits up to five minutes for npm to serve the version. Then it tags the commit `vX.Y.Z` and makes a GitHub release for the tag. This is the only job that can write to the repository. A tag the workflow makes starts no workflow.

One promotion runs at a time. A second one waits for the first to end. If a third is started while the second waits, GitHub cancels the second.

The version exists only in the published package. `package.json` on `main` stays at 0.0.0, so a release needs no commit of its own. From a checkout of `main`, `retest --version` prints 0.0.0.

## When a promotion fails

Open the run and choose "Re-run failed jobs". GitHub keeps the jobs that passed, with their results.

- If npm already has the version, the publish job publishes nothing and the run goes on to the tag.
- The tag job accepts a tag that already names the commit, and a release that already exists.
- If a higher version reached npm since the first attempt, the publish job stops. Publishing a lower version would move npm's `latest` back to it.

A new run, or "Re-run all jobs", checks everything again. For a version npm already has, it stops at the first job and changes nothing.

## Staged publishing

npm can hold each new version until a maintainer approves it on npmjs.com. Publishing the Rehearsal CLI works this way. If Retest's publishes are staged, a promotion goes like this:

1. The publish job succeeds and writes the receipt.
2. npm does not serve the version yet, so the tag job fails after five minutes. There is no tag or release yet.
3. Approve the version on npmjs.com, and check it with `npm view @rehearsal-labs/retest@<version> version`.
4. Choose "Re-run failed jobs" on the same run. The tag job finds the version, tags the commit and makes the release.

Do not start a new promotion for that version. npm does not list a staged version, so the new run would pass its checks and the gates, then npm would refuse the publish.

## Run the gates by hand

`ci.yml` runs every gate on any branch, tag or commit. Nothing starts it by itself. Open Actions, choose CI, run it from `main`, and enter what to check. The default is `main`.

```sh
gh workflow run ci.yml --ref main -f ref=<branch, tag or full SHA>
```

The first job turns the ref into one commit, inventories the unit and integration test files, and assigns each file exactly once per platform. Every job checks that commit. A promotion always requests the full matrix.

- Build, TypeScript and consumer type checks report independently on Linux x64, Linux arm64, macOS arm64 and Windows x64. Unit files run in shards of about 150 seconds of tests per platform, one file at a time on each machine. Windows runs on the standard `windows-2025` runner. Its unit shards build the process supervisor first, since every process a Windows run starts is held in a Job Object through it.
- Linux integration runs in shards of about 300 seconds of tests per architecture through `docker/linux/run.sh`, with Chrome's sandbox on. The image holds Google Chrome, Debian's Chromium, Rust 1.88.0, a linker, ffmpeg and ffprobe. On x64 it fetches the locked media dependencies, builds the release binary offline and runs the media reply tests. The packed-source installer and recording tests retain these prerequisites. Native files remain assigned on Linux, including their portable controls and explicit platform skips. Linux arm64 still has no verified media target.
- On the standard `macos-26` arm64 runner it uses Node.js 24.12.0, the oldest version `package.json` allows. The media reply tests use locked Rust dependencies and run offline. Integration uses the runner's Google Chrome, Chrome for Testing 153.0.8010.12, Firefox 158.0.1, WebKit build 2359 and Electron 44.5.1. The WebKit executable and framework require macOS 26.5 or later. Setup checks that minimum; [GitHub lists macOS 26 as a standard public runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).
- `scripts/ci/prepare-macos-integration.ts` downloads the archives through Retest's downloader and checks the sizes and SHA-256 pins in `src/browser/builds.ts`. It keeps copies for the installer tests and seeds the product installer's download cache. The built `retest install chromium firefox webkit electron media` command installs those copies, verifies their files and notices, and builds retest-media 0.1.0 from the checked commit's pinned source with `cargo build --release --locked`. No browser archive is downloaded twice in a shard.
- Each macOS integration shard installs Rust 1.88.0, the oldest version the media crate supports, through rustup and ffmpeg with ffprobe through Homebrew. It exports the installed browser paths, the WebKit build folder and both the test and product media paths. Firefox uses the `spawn` route. Setup prints the OS, architecture, default Xcode, exported paths and tool versions, and verifies the installed files before integration tests.
- Setup restores two caches: npm's downloads and the four browser archives. npm checks each package against the lock file's integrity hash. `scripts/ci/macos-cache-keys.ts` reads the archive cache key and the Rust version from the product's pins; the key names each archive's address, size and SHA-256, so a changed pin starts a new cache. A cached archive is used only when its size and SHA-256 match the pin; anything else is downloaded again. A miss makes everything as before. The archive cache is saved as soon as it is made, so a shard whose tests fail still leaves it; setup-node saves npm's cache only when the job succeeds. The Rust toolchain and the media builds are made fresh in every shard.
- macOS browser integration runs in shards of about 360 seconds of tests. The files that use the desktop or simulator run in their own native shards, also of 360 seconds. Every shard runs one file at a time on its own machine, preserving test assertions, deadlines and shared-resource isolation. All integration files remain assigned. Native tests retain their exact Xcode checks and existing skips; the workflow leaves the default Xcode selected and installs no native executor.
- The assignment uses `scripts/ci/test-durations.json`: for each file, its slowest passing time on each platform, rounded up to whole seconds: on Windows from CI run 40026460747 of 23 October 2026, and on Linux and macOS from CI run 38176885689 of 11 October 2026. Each platform plans a file by its own time. A file with no time on a platform counts the largest time another platform has; a file no passing run has timed counts 20 seconds for integration and 1 for unit. These are balancing weights, not promised CI timings. A new file is included automatically. Each shard writes file results and actual elapsed times to a seven-day metadata artifact. TAP prints failure details immediately. Native screenshots and recordings are not included in these metadata artifacts.
- Windows integration runs in shards of about 300 seconds of tests through `.github/actions/setup-windows-integration`: Rust 1.88.0 through rustup and ffmpeg through Chocolatey, the pinned Chrome for Testing, Firefox and Electron archives from a cache keyed by the pins, then `retest install supervisor chromium firefox electron media` and a verification of every installed file. The browser files run on the runner image's own Google Chrome, as on macOS; the pinned Chrome for Testing is the second browser.
- Integration jobs start once build and types pass on every platform. They do not wait for the unit shards, and a failed unit shard still fails the final job.
- Job limits are 15 minutes for build/types, 20 for unit shards, 20 for Linux integration, 20 for macOS browser integration and 75 for macOS native integration. A final job refuses a missing, failed or cancelled requested job. The full matrix remains required for promotion.

For a failed file, choose its suite and platform instead of repeating the full matrix:

```sh
gh workflow run ci.yml --ref main -f ref=<full SHA> \
  -f suite=integration -f platform=linux-x64 \
  -f files=tests/integration/browser-state.test.ts
```

Multiple file paths can be passed as one quoted, space-separated value. Unknown paths, duplicates and files from the wrong suite are refused before any test job starts. `suite=checks` runs build and type checks only. A focused run is labelled as focused and cannot replace the full promotion gates. A new manual run cancels an older manual run from the same workflow branch, suite and platform; promotion calls are never cancelled by that rule.

`suite=fast` is a quick first look at what fails. It runs build, types and unit files on the selected platforms. When macOS is selected, it also runs the integration files that took under 60 seconds on macOS or that no run has timed yet; it runs no integration on Linux. With every platform selected, the current durations give 8 macOS browser shards and 1 native shard: about 104 macOS minutes, so at least 21 minutes at 5 macOS jobs at a time. Like a focused run, it says that it does not establish release coverage.

Every third-party action is pinned by its full commit SHA, with the version in a comment. To update an action, change both.

## How long a full run takes

Each lane on each platform gets as many shards as its recorded time there needs: the lane's total divided by its target, rounded up. The targets are 360 seconds of tests for a macOS browser or native shard, 300 for a Linux shard and 150 for a unit shard. Files go largest first into the emptiest shard, so no shard ends more than its largest file past its target. With the current durations the full matrix has these shards:

| Lane | macOS arm64 | Linux x64 | Linux arm64 | Windows x64 |
| --- | --- | --- | --- | --- |
| Build and types | 1 | 1 | 1 | 1 |
| Unit | 9 | 6 | 6 | 8 |
| Browser integration | 16 | 8 | 7 | 20 |
| Native integration | 1 | | | |

The organization is on GitHub's free plan. At most 20 jobs run at once, Linux and macOS together, and at most 5 of them on macOS, so macOS sets the pace. In run 38176885689 a macOS integration shard spent about 4 minutes on setup before its first test, from 3.3 to 4.4. A unit shard spent about half a minute, and build and types took 71 seconds. By the planner's estimates, which round each file up to a whole second, the full matrix holds about 177 macOS job-minutes:

| Part | macOS minutes |
| --- | --- |
| Browser tests | 89 |
| Setup of 15 browser shards | 59 |
| 8 unit shards | 23 |
| Native shard | 4 |
| Build and types | 1 |

At 5 jobs at a time, a full run cannot end sooner than about 35 minutes after its first job. Run 38176885689 had 4 browser shards: 128 macOS minutes, a floor of 26 minutes. It took 35 minutes. Integration waited 5 minutes for the unit shards, and each browser shard ran 20 to 28 minutes.

More shards do not shorten the run, because each one pays its setup again. They make each job short: a browser shard takes about 10 minutes with its setup. A failed shard reruns in 10 minutes rather than 28, and the 20-minute limit stops a stuck one. Shorter setup is what shortens the run. Each minute saved in setup saves about 3 minutes of the run: 16 macOS integration shards, 5 at a time.

The caches save little of the 4 minutes. In the two shards of run 38176885689 whose logs were read, the four archive downloads took 5 to 9 seconds, and the archive cache mostly spares each shard four downloads from four publishers. The largest setup steps were building retest-media, 48 to 71 seconds, and its reply tests, 46 to 60 seconds. Installing Firefox took 36 to 39 seconds.

That floor holds only while Linux leaves 5 of the 20 job slots free for macOS. Linux has 27 jobs: 2 for build and types, 12 unit shards of about 2.5 minutes and 13 integration shards of 6 to 7 minutes, about 119 job-minutes. Linux wants more than 15 slots only in the first minutes, while its unit shards and its integration shards overlap. Then it runs within 15 slots, and its last shard ends about 10 minutes in, well before macOS. A plan that gives Linux more shards takes slots macOS needs.

## Refresh the durations

After a full run whose files took notably longer or shorter, rewrite the durations from its artifacts, from the repository root:

```sh
gh run download <run id> --repo rehearsal-labs/retest --dir /tmp/retest-run-<run id>
node scripts/ci/refresh-durations.ts /tmp/retest-run-<run id>
```

Each file gets, on each platform, its slowest passing time there, rounded up to whole seconds. The platform is read from the artifact's name. A file that failed, was killed or was cut off gives no time. The command changes nothing when some file has no passing time on some platform, and it names those files; such a file either had a time before or ran in that run. Pass `--partial` to write the times it has and keep the earlier times for the rest:

```sh
node scripts/ci/refresh-durations.ts --partial /tmp/retest-run-<run id>
```

A file the repository no longer holds is dropped, and the command prints which. A renamed or split file is new to the durations: give it a value by hand before the refresh, on each platform, as the three conformance files got a third of the file they replaced. Otherwise it counts the 20-second default until a run times it. Commit the new `scripts/ci/test-durations.json`. GitHub keeps the artifacts for 7 days.

## The first release

npm lets a package name a trusted publisher only once the package exists, so 0.1.0 is published by hand. Follow steps 1 through 8 for that release. Apply step 10 as soon as npm serves 0.1.0. Wait until the next promotion is ready before step 9.

- [ ] **1. Get the workflows onto `main`.** Push the commit that holds `promote.yml` and this `ci.yml`. The push starts nothing. GitHub offers a workflow to run by hand only once it is on the default branch.

- [ ] **2. Remove `private` in its own commit.** On a clean `main`:

  ```sh
  npm pkg delete private
  ```

  In the same commit, change the line in `docs/guide.md` that says the package is not published and is marked private. Leave the version at 0.0.0. Push the commit to `main`.

- [ ] **3. Choose the commit and run the gates on it.** Take that commit or any later one on `main`, and write down its full SHA. Run CI on it and wait for every job to pass:

  ```sh
  gh workflow run ci.yml --ref main -f ref=<commit>
  ```

- [ ] **4. Check out the chosen commit cleanly.** Publish from a fresh clone, never from your working tree, because npm packs whatever `dist/` holds.

  ```sh
  git clone https://github.com/rehearsal-labs/retest.git /tmp/retest-0.1.0
  cd /tmp/retest-0.1.0
  git checkout --detach <commit>
  ```

- [ ] **5. Stamp the version, build and publish with two-factor.** `npm whoami` must name an account that can publish to the `rehearsal-labs` organization.

  ```sh
  npm version 0.1.0 --no-git-tag-version
  npm ci && npm run build
  node dist/cli/main.js --version   # prints 0.1.0
  npm publish --access public --provenance=false
  ```

  npm asks for the two-factor code. `package.json` asks for provenance, and npm can make provenance only inside CI, so the command turns it off. A flag on the command line wins over `publishConfig`.

- [ ] **6. Check that npm serves it.** `npm view @rehearsal-labs/retest@0.1.0 version` prints `0.1.0`. Then delete `/tmp/retest-0.1.0`.

- [ ] **7. Tag the commit.** From your own clone:

  ```sh
  git tag v0.1.0 <commit>
  git push origin v0.1.0
  ```

  No workflow starts on a tag. Make its GitHub release too, so every version on npm has one:

  ```sh
  gh release create v0.1.0 --verify-tag --title v0.1.0 --generate-notes
  ```

- [ ] **8. Create the `npm` environment.** On GitHub, open the repository's Settings, then Environments, and add `npm`. Under deployment branches, allow only `main`. Under required reviewers, add yourself. The publish job waits in it until you approve, and npm accepts a publish only from this environment.

- [ ] **9. Configure the trusted publisher when the next promotion is ready.** On npmjs.com, open the package's settings. Under Trusted publishing, choose GitHub Actions. Enter organization `rehearsal-labs`, repository `retest`, workflow filename `promote.yml` and environment `npm`. Under Allowed actions, enable direct publishing with `npm publish`, then save. `promote.yml` uses that command. [npm documents these fields and permissions](https://docs.npmjs.com/trusted-publishers/#for-github-actions).

  Complete the first successful CI publish within two days of saving the configuration. [npm expires an unused configuration after two days](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry). If it expires, delete it and create it again before publishing.

- [ ] **10. Require two-factor and disallow tokens after 0.1.0.** As soon as npm serves 0.1.0, open the package's settings. Under Publishing access, choose "Require two-factor authentication and disallow tokens" and save. Manual publishing requires two-factor. Traditional publish tokens are blocked; trusted publishing still works. [npm explains this setting](https://docs.npmjs.com/trusted-publishers/#how-to-configure-maximum-security).

From then on every release is a promotion.

## The published manifest

npm publishes the root `package.json` of the promoted commit, with the version written in.

- `files` ships `dist`, the media crate manifest, lock, build script and Rust sources, `LICENSE`, and the installer media notices and licence files. npm also adds `package.json` and `README.md`.
- `bin` is `dist/cli/main.js`, with no leading `./`. npm 11 removes a bin path written with `./` when it publishes, and the package then installs no `retest` command.
- `repository` names `rehearsal-labs/retest`. npm rejects a provenance statement whose repository differs from the manifest's.
- `publishConfig` sets public access and provenance. A publish from a laptop fails unless it passes `--provenance=false`.
- `exports` keeps the `retest-source` condition, which points into `src/`. The package does not ship those TypeScript entry points. Node uses a custom condition only when a command names it, as Retest's own tests do with `--conditions=retest-source`. A project that never names it gets `dist/`. A project that names it gets `ERR_MODULE_NOT_FOUND`, never a different file. Stripping the condition in the workflow would publish a manifest that differs from the tarball the integration tests pack and from the hand-published 0.1.0.
