import { commandResultSchema, pageCommandSchema, type CommandResult, type PageCommand } from './commands.ts'
import { childEventSchema, type ChildEvent } from './events.ts'
import { failureSchema, sourceLocationSchema, type Failure, type SourceLocation } from './failures.ts'
import { s, type Schema } from './schema.ts'
import { timeoutsSchema, type Timeouts } from './timeouts.ts'

/** A test as the child registered it. `timeout` is the test's own budget in milliseconds. */
export type RegisteredTest = { name: string; location: SourceLocation; timeout?: number }

/** A message from the parent to the child. */
export type ParentMessage =
  | { type: 'collect'; file: string; rootDir: string }
  | { type: 'run'; testId: string; attemptId: string; timeouts: Timeouts }
  | { type: 'command-result'; id: number; result: CommandResult }
  | { type: 'abort'; reason: string }
  | { type: 'close' }

/**
 * A message from the child to the parent. A command carries the step the test code was in when it sent it.
 * `process-error` is an error thrown while no test was running, sent just before the process ends.
 */
export type ChildMessage =
  | { type: 'collected'; tests: RegisteredTest[] }
  | { type: 'collection-failed'; failure: Failure }
  | { type: 'command'; id: number; command: PageCommand; location?: SourceLocation; stepId?: string; timeoutMs: number }
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

export const parentMessageSchema: Schema<ParentMessage> = s.discriminatedUnion('type', [
  s.object({ type: s.literal('collect'), file: s.string(), rootDir: s.string() }),
  s.object({ type: s.literal('run'), testId: s.string(), attemptId: s.string(), timeouts: timeoutsSchema }),
  s.object({ type: s.literal('command-result'), id: count, result: commandResultSchema }),
  s.object({ type: s.literal('abort'), reason: s.string() }),
  s.object({ type: s.literal('close') }),
])

export const childMessageSchema: Schema<ChildMessage> = s.discriminatedUnion('type', [
  s.object({
    type: s.literal('collected'),
    tests: s.array(
      s.object({
        name: s.string(),
        location: sourceLocationSchema,
        timeout: s.optional(s.number({ integer: true, min: 1 })),
      }),
    ),
  }),
  s.object({ type: s.literal('collection-failed'), failure: failureSchema }),
  s.object({
    type: s.literal('command'),
    id: count,
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
