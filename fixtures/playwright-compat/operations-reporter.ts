import { writeFileSync } from 'node:fs'

// A Playwright reporter that writes every test's result and its whole tree of steps, with their categories and
// lines, to one JSON file, which `scripts/compare-playwright.ts` reads beside Retest's events. Playwright's own JSON
// reporter keeps only `test.step` steps, and the comparison needs each action and check as well. The shapes below
// are the parts of Playwright's reporter objects this file reads, written out here because the repository does not
// install Playwright.

type ReportedLocation = { readonly file: string; readonly line: number; readonly column: number }

type ReportedError = { readonly message?: string; readonly location?: ReportedLocation }

type ReportedStep = {
  readonly title: string
  readonly category: string
  readonly location?: ReportedLocation
  readonly error?: ReportedError
  readonly steps: readonly ReportedStep[]
}

type ReportedTest = { readonly title: string; readonly location: ReportedLocation; titlePath(): string[] }

type ReportedResult = { readonly status: string; readonly errors: readonly ReportedError[]; readonly steps: readonly ReportedStep[] }

/** One step as the comparison reads it. */
export type RecordedStep = {
  readonly title: string
  readonly category: string
  readonly location?: ReportedLocation
  readonly error?: string
  readonly steps: RecordedStep[]
}

/** One test's result as the comparison reads it. */
export type RecordedTest = {
  readonly file: string
  readonly title: string
  readonly titlePath: string[]
  readonly status: string
  readonly errors: { readonly message: string; readonly location?: ReportedLocation }[]
  readonly steps: RecordedStep[]
}

function recordStep(step: ReportedStep): RecordedStep {
  return {
    title: step.title,
    category: step.category,
    ...(step.location === undefined ? {} : { location: step.location }),
    ...(step.error === undefined ? {} : { error: step.error.message ?? '' }),
    steps: step.steps.map(recordStep),
  }
}

export default class OperationsReporter {
  readonly #outputFile: string
  readonly #tests: RecordedTest[] = []

  constructor(options: { readonly outputFile?: string }) {
    if (options.outputFile === undefined || options.outputFile === '') throw new Error('The operations reporter needs an outputFile.')
    this.#outputFile = options.outputFile
  }

  onTestEnd(test: ReportedTest, result: ReportedResult): void {
    this.#tests.push({
      file: test.location.file,
      title: test.title,
      titlePath: test.titlePath(),
      status: result.status,
      errors: result.errors.map((error) => ({ message: error.message ?? '', ...(error.location === undefined ? {} : { location: error.location }) })),
      steps: result.steps.map(recordStep),
    })
  }

  onEnd(): void {
    writeFileSync(this.#outputFile, `${JSON.stringify(this.#tests, null, 2)}\n`)
  }

  printsToStdio(): boolean {
    return false
  }
}
