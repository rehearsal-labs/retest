import type { TestResult } from '../protocol/result.ts'
import type { PlannedTest } from './plan.ts'
import { variantKey } from '../protocol/variant.ts'

/**
 * A file's results in the order its tests are declared, each test's runs in the order of its variants: the order
 * collection lists them in, so `result.json` and a result rebuilt from the events agree, whatever order the attempts
 * ran or were recorded in. `variants` false is milestone 1's mode, whose results have no variant.
 *
 * @example inDeclarationOrder(record.tests, file.tests, config.variants)
 */
export function inDeclarationOrder(results: readonly TestResult[], tests: readonly PlannedTest[], variants: boolean): TestResult[] {
  const positions = new Map<string, number>()
  for (const test of tests) {
    const keys = variants ? test.variants.map((variant) => variantKey(variant)) : ['']
    for (const key of keys) positions.set(resultKey(test.testId, key), positions.size)
  }
  const position = (result: TestResult): number => positions.get(resultKey(result.testId, result.variantKey ?? '')) ?? Number.POSITIVE_INFINITY
  return [...results].sort((first, second) => position(first) - position(second))
}

function resultKey(testId: string, key: string): string {
  return `${testId}\n${key}`
}
