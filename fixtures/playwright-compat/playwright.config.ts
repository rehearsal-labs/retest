// The configuration `scripts/compare-playwright.ts` runs the corpus with under Playwright: the task app's address,
// the same Chrome Retest runs in, one worker, no retries and the 1.5 second assertion budget the workflow cases use.
// Retest reads no playwright.config.ts; the comparison gives it the same address, browser, worker and budget on its
// command line. The environment names are the comparison's own.

/** The parts of Playwright's configuration the corpus sets. */
type CorpusConfig = {
  readonly testDir: string
  readonly fullyParallel: boolean
  readonly workers: number
  readonly retries: number
  readonly expect: { readonly timeout: number }
  readonly reporter: readonly (readonly [string, { readonly outputFile: string | undefined }])[]
  readonly use: { readonly baseURL: string | undefined; readonly headless: boolean; readonly launchOptions: { readonly executablePath: string | undefined } }
}

const config: CorpusConfig = {
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  expect: { timeout: 1500 },
  reporter: [['./operations-reporter.ts', { outputFile: process.env['COMPARE_REPORT_FILE'] }]],
  use: {
    baseURL: process.env['WORKFLOW_APP_URL'],
    headless: true,
    launchOptions: { executablePath: process.env['COMPARE_BROWSER'] },
  },
}

export default config
