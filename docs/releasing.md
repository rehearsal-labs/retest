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
2. **Gates.** It calls `ci.yml` on the commit, and every Linux and macOS gate must pass. The gates are `ci.yml` as it is on `main`, and the code they check is the commit's.
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

The first job turns the ref into one commit, and every gate checks that commit. The run summary names it. A promotion runs the same jobs.

- On Linux, x64 and arm64, it runs `docker/linux/run.sh`. That builds the harness image and runs build, typecheck, unit, types and integration with Chrome's sandbox on. The image holds both browsers the integration tests use, Google Chrome and Debian's Chromium.
- On the standard `macos-26` arm64 runner it uses Node.js 24.12.0, the oldest version `package.json` allows. It runs `npm ci`, build, typecheck, unit, types and integration. Integration uses the runner's Google Chrome, Chrome for Testing 153.0.8010.12, Firefox 133.0.3, WebKit build 2359 and Electron 44.5.1. The WebKit executable and framework require macOS 26.5 or later. Setup checks that minimum; [GitHub lists macOS 26 as a standard public runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories).
- `scripts/ci/prepare-macos-integration.ts` downloads the archives through Retest's downloader and checks the sizes and SHA-256 pins in `src/browser/builds.ts`. It keeps copies for the installer tests and seeds the product installer's download cache. The built `retest install chromium firefox webkit electron media` command installs those copies, verifies their files and notices, and builds retest-media 0.1.0 from the checked commit's pinned source with `cargo build --release --locked`. No browser archive is downloaded twice.
- The macOS job installs Rust 1.88.0 through rustup and ffmpeg with ffprobe through Homebrew. It exports the installed browser paths, the WebKit build folder and both the test and product media paths. Firefox uses the `spawn` route. Setup prints the OS, architecture, default Xcode, exported paths and tool versions, and verifies the installed files before typecheck and tests.
- The macOS integration command uses Node's TAP reporter with the same file selection and one file at a time as `npm run test:integration`. Failure details appear when a test fails. The job still has a 60-minute limit. Native tests retain their checks for the exact pinned Xcode build and report skips where it is unavailable; the workflow leaves the default Xcode selected and installs no native executor.

Every third-party action is pinned by its full commit SHA, with the version in a comment. To update an action, change both.

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
