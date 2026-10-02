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
