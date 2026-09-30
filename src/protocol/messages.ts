import { commandResultSchema, pageCommandSchema, type CommandResult, type PageCommand } from './commands.ts'
import { childEventSchema, type ChildEvent } from './events.ts'
import { failureSchema, sourceLocationSchema, type Failure, type SourceLocation } from './failures.ts'
import { s, type Schema } from './schema.ts'
import { timeoutsSchema, type Timeouts } from './timeouts.ts'
import { variantSchema, type Variant } from './variant.ts'

/** The one app of milestone 1's mode, which has no config. Its commands and events name it as their app. */
export const singleAppName = 'page'

/** A `test.describe` block a test sits in. */
export type DescribeBlock = { name: string; location: SourceLocation }

/**
 * A test as the child registered it. `timeout` is the test's own budget in milliseconds. `describes` lists its
 * `test.describe` blocks, outermost first. `tags`, `apps` and `state` are the test's own merged with its
 * blocks'; `apps` holds only what the test declared, so a test without it uses the default app. `state` is a
 * state name, or state names by app. `setup` marks a `test.setup`, and `row` a `test.for` row: the name
 * template and the row's index. Each optional field is present only when it says something.
 */
export type RegisteredTest = {
  name: string
  location: SourceLocation
  timeout?: number
  describes?: DescribeBlock[]
  tags?: string[]
  apps?: string[]
  state?: string | Record<string, string>
  setup?: true
  row?: { template: string; index: number }
}

/**
 * A message from the parent to the child. `run.apps` names the apps the test's handles send commands to, in the
 * order the test declared them; a test that declared none has its default app, or `singleAppName`. `variant`
 * is the target of each app, when the run has a config.
 */
export type ParentMessage =
  | { type: 'collect'; file: string; rootDir: string }
  | { type: 'run'; testId: string; attemptId: string; timeouts: Timeouts; apps: string[]; variant?: Variant }
  | { type: 'command-result'; id: number; result: CommandResult }
  | { type: 'abort'; reason: string }
  | { type: 'close' }

/**
 * A message from the child to the parent. A command names the app whose page takes it, and carries the step
 * the test code was in when it sent it. `process-error` is an error thrown while no test was running, sent
 * just before the process ends.
 */
export type ChildMessage =
  | { type: 'collected'; tests: RegisteredTest[] }
  | { type: 'collection-failed'; failure: Failure }
  | {
      type: 'command'
      id: number
      app: string
      command: PageCommand
      location?: SourceLocation
      stepId?: string
      timeoutMs: number
    }
  | { type: 'event'; event: ChildEvent }
  | {
      type: 'test-finished'
      testId: string
      attemptId: string
      status: 'passed' | 'failed'
      failure?: Failure
      assertionCount: number
      durationMs: number
    }
  | { type: 'process-error'; failure: Failure }

const count = s.number({ integer: true, min: 0 })
const names = s.optional(s.array(s.string()))

const registeredTestSchema: Schema<RegisteredTest> = s.object({
  name: s.string(),
  location: sourceLocationSchema,
  timeout: s.optional(s.number({ integer: true, min: 1 })),
  describes: s.optional(s.array(s.object({ name: s.string(), location: sourceLocationSchema }))),
  tags: names,
  apps: names,
  state: s.optional(s.union([s.string(), s.record(s.string())])),
  setup: s.optional(s.literal(true)),
  row: s.optional(s.object({ template: s.string(), index: count })),
})

export const parentMessageSchema: Schema<ParentMessage> = s.discriminatedUnion('type', [
  s.object({ type: s.literal('collect'), file: s.string(), rootDir: s.string() }),
  s.object({
    type: s.literal('run'),
    testId: s.string(),
    attemptId: s.string(),
    timeouts: timeoutsSchema,
    apps: s.array(s.string()),
    variant: s.optional(variantSchema),
  }),
  s.object({ type: s.literal('command-result'), id: count, result: commandResultSchema }),
  s.object({ type: s.literal('abort'), reason: s.string() }),
  s.object({ type: s.literal('close') }),
])

export const childMessageSchema: Schema<ChildMessage> = s.discriminatedUnion('type', [
  s.object({ type: s.literal('collected'), tests: s.array(registeredTestSchema) }),
  s.object({ type: s.literal('collection-failed'), failure: failureSchema }),
  s.object({
    type: s.literal('command'),
    id: count,
    app: s.string(),
    command: pageCommandSchema,
    location: s.optional(sourceLocationSchema),
    stepId: s.optional(s.string()),
    timeoutMs: count,
  }),
  s.object({ type: s.literal('event'), event: childEventSchema }),
  s.object({
    type: s.literal('test-finished'),
    testId: s.string(),
    attemptId: s.string(),
    status: s.enum(['passed', 'failed']),
    failure: s.optional(failureSchema),
    assertionCount: count,
    durationMs: s.number({ min: 0 }),
  }),
  s.object({ type: s.literal('process-error'), failure: failureSchema }),
])
