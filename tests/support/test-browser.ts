import { existsSync } from 'node:fs'

/** Where Google Chrome installs on macOS: the browser the tests and the benchmarks use unless told otherwise. */
export const DEFAULT_BROWSER: string = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * The browser to test with: RETEST_TEST_BROWSER, or Google Chrome where macOS installs it.
 *
 * @example browserPath() // '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
 */
export function browserPath(): string {
  const configured = process.env['RETEST_TEST_BROWSER']
  if (configured) return configured
  if (existsSync(DEFAULT_BROWSER)) return DEFAULT_BROWSER
  throw new Error(`No browser to test with: set RETEST_TEST_BROWSER, or install Google Chrome at ${DEFAULT_BROWSER}`)
}

/**
 * Chrome's headless shell to test with, which a headless chromium() target runs: RETEST_TEST_HEADLESS_SHELL. There is no
 * default place, since the shell is installed by \`retest install chromium\` into a cache of its own.
 *
 * @example headlessShellPath() // '/home/ada/.cache/retest/browsers/headless-shell-153.0.8010.12-linux-x64/build/chrome-headless-shell-linux64/chrome-headless-shell'
 */
export function headlessShellPath(): string {
  const configured = process.env['RETEST_TEST_HEADLESS_SHELL']
  if (configured) return configured
  throw new Error('No headless shell to test with: set RETEST_TEST_HEADLESS_SHELL to the chrome-headless-shell retest install chromium installs.')
}
