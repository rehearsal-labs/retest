import type { SourceLocation } from '../../src/protocol/failures.ts'
import type { RegisteredTest } from '../../src/protocol/messages.ts'
import type { CollectedTests, Plan } from '../../src/runner/plan.ts'
import type { RunConfig } from '../../src/runner/run-config.ts'
import assert from 'node:assert/strict'
import { validateConfig } from '../../src/config/validate.ts'
import { planTests } from '../../src/runner/plan.ts'
import { collectConfig } from '../../src/runner/run-config.ts'

/** The config a run follows, from the object a config file exports. */
export function configOf(value: unknown): RunConfig {
  const loaded = validateConfig(value, '/work/retest.config.ts')
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
  return collectConfig(loaded.config)
}

/** A chromium target that needs nothing from the machine. */
export function target(name: string): { browser: 'chromium'; executablePath: string } {
  return { browser: 'chromium', executablePath: `/fake/${name}` }
}

/** An app with these targets. */
export function appWith(...targets: string[]): { baseUrl: string; targets: Record<string, ReturnType<typeof target>> } {
  return { baseUrl: 'http://127.0.0.1:4173', targets: Object.fromEntries(targets.map((name) => [name, target(name)])) }
}

/** A test as a file's process registers it, declared on `line`. */
export function registered(name: string, line: number, extra: Partial<RegisteredTest> = {}): RegisteredTest {
  return { name, location: at(line), ...extra }
}

/** A location in the file every fixture test sits in. */
export function at(line: number, file = 'tests/a.retest.ts'): SourceLocation {
  return { file, line, column: 1 }
}

/** What collection found in each file, planned against a config. */
export function planOf(config: RunConfig, files: Readonly<Record<string, RegisteredTest[]>>): Plan {
  const collected: CollectedTests[] = Object.entries(files).map(([file, tests]) => ({ file, ok: true, tests }))
  return planTests(collected, config)
}
