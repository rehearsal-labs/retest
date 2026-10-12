import { commandResultSchema, pageCommandSchema, type CommandResult, type PageCommand } from './commands.ts'
import { dialogAnswerSchema, dialogRequestSchema, type DialogAnswer, type DialogRequest } from './dialogs.ts'
import { evaluationAnswerSchema, evaluationCallSchema, type EvaluationAnswer, type EvaluationCall } from './evaluation.ts'
import { childEventSchema, type ChildEvent } from './events.ts'
import { failureSchema, sourceLocationSchema, type Failure, type SourceLocation } from './failures.ts'
import { filesAnswerSchema, filesRequestSchema, type FilesAnswer, type FilesRequest } from './files.ts'
import { inboxAnswerSchema, inboxRequestSchema, type InboxAnswer, type InboxRequest } from './inbox.ts'
import { popupAnswerSchema, popupRequestSchema, type PopupAnswer, type PopupRequest } from './popups.ts'
import { routeReplySchema, routeRequestSchema, type RouteReply, type RouteRequest } from './routes.ts'
import { s, type Schema } from './schema.ts'
import { timeoutsSchema, type Timeouts } from './timeouts.ts'
import { variantSchema, type Variant } from './variant.ts'

/** The one app of milestone 1's mode, which has no config. Its commands and events name it as their app. */
export const singleAppName = 'page'

/** A `test.describe` block a test sits in. `only` marks a `test.describe.only`. */
export type DescribeBlock = { name: string; location: SourceLocation; only?: true }

/**
 * A test as the child registered it. `timeout` is the test's own budget in milliseconds. `describes` lists its
 * `test.describe` blocks, outermost first. `tags`, `apps` and `state` are the test's own merged with its
 * blocks'; `apps` holds only what the test declared, so a test without it uses the default app. `state` is a
 * state name, or state names by app. `setup` marks a `test.setup`, and `row` a `test.for` row: the name
 * template and the row's index. `skip` marks a test that `test.skip` or a `test.describe.skip` around it declared,
 * `only` a `test.only`, and `locks` the names of the shared state it holds, its own and its blocks'. Each optional
 * field is present only when it says something.
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
  skip?: true
  only?: true
  locks?: string[]
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
  | { type: 'evaluation-result'; id: number; answer: EvaluationAnswer }
  | { type: 'inbox-result'; id: number; answer: InboxAnswer }
  | { type: 'dialog-result'; id: number; answer: DialogAnswer }
  | { type: 'popup-result'; id: number; answer: PopupAnswer }
  | { type: 'files-result'; id: number; answer: FilesAnswer }
  | { type: 'route-result'; id: number; answer: RouteReply }
  | { type: 'abort'; reason: string }
  | { type: 'close' }

/**
 * A message from the child to the parent. A command names the app whose page takes it, and carries the step
 * the test code was in when it sent it. `callTimeoutMs` is the time an action gave itself with `{ timeout }`, which
 * the parent cuts to its own budget for the action. `process-error` is an error thrown while no test was running,
 * sent just before the process ends. `modules` on `collected` and `test-finished` names every project module the
 * process has loaded so far, by its path from the root; the parent reads and hashes each file itself.
 */
export type ChildMessage =
  | { type: 'collected'; tests: RegisteredTest[]; modules?: string[] }
  | { type: 'collection-failed'; failure: Failure }
  | {
      type: 'command'
      testId: string
      attemptId: string
      id: number
      app: string
      command: PageCommand
      location?: SourceLocation
      stepId?: string
      timeoutMs: number
      callTimeoutMs?: number
    }
  | { type: 'event'; event: ChildEvent }
  /** `test.evaluate`: the check the parent runs and judges itself, never the evidence or a verdict. */
  | { type: 'evaluate'; testId: string; attemptId: string; id: number; call: EvaluationCall; location?: SourceLocation; stepId?: string }
  /** A read of an inbox: the parent reads the mailbox itself, and answers with the message, its codes and links hidden. */
  | { type: 'inbox'; testId: string; attemptId: string; id: number; request: InboxRequest; timeoutMs: number; location?: SourceLocation; stepId?: string }
  /**
   * A wait for the next JavaScript dialog an app's page opens, a stop of that wait, or an answer to a dialog the test was
   * given. The parent arms the page, answers once the dialog opens or once `timeoutMs` runs out, and answers the dialog.
   */
  | { type: 'dialog'; testId: string; attemptId: string; id: number; app: string; request: DialogRequest; timeoutMs: number; location?: SourceLocation; stepId?: string }
  /**
   * A wait for the next page an app's page opens, or a stop of that wait. The parent arms the page, and answers with the
   * app name the new page's commands go to once it has opened, or once `timeoutMs` runs out.
   */
  | { type: 'popup'; testId: string; attemptId: string; id: number; app: string; request: PopupRequest; timeoutMs: number; location?: SourceLocation; stepId?: string }
  /**
   * A file picker or a download to wait for, or a download to wait for until it is saved: the parent arms the page and
   * answers once it happens, or once `timeoutMs` runs out. A `release` lets go of an arm, and is not answered.
   */
  | { type: 'files'; testId: string; attemptId: string; id: number; request: FilesRequest; timeoutMs: number; location?: SourceLocation; stepId?: string }
  /**
   * A change to an app's routes: a route to add, or a pattern whose routes to remove. The parent answers once the page
   * holds the change, so the next command to the page meets it, or once `timeoutMs` runs out.
   */
  | { type: 'route'; testId: string; attemptId: string; id: number; app: string; request: RouteRequest; timeoutMs: number; location?: SourceLocation; stepId?: string }
  | {
      type: 'test-finished'
      testId: string
      attemptId: string
      status: 'passed' | 'failed'
      failure?: Failure
      assertionCount: number
      durationMs: number
      modules?: string[]
    }
  | { type: 'process-error'; failure: Failure }

const count = s.number({ integer: true, min: 0 })
const names = s.optional(s.array(s.string()))

const registeredTestSchema: Schema<RegisteredTest> = s.object({
  name: s.string(),
  location: sourceLocationSchema,
  timeout: s.optional(s.number({ integer: true, min: 1 })),
  describes: s.optional(s.array(s.object({ name: s.string(), location: sourceLocationSchema, only: s.optional(s.literal(true)) }))),
  tags: names,
  apps: names,
  state: s.optional(s.union([s.string(), s.record(s.string())])),
  setup: s.optional(s.literal(true)),
  row: s.optional(s.object({ template: s.string(), index: count })),
  skip: s.optional(s.literal(true)),
  only: s.optional(s.literal(true)),
  locks: names,
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
  s.object({ type: s.literal('evaluation-result'), id: count, answer: evaluationAnswerSchema }),
  s.object({ type: s.literal('inbox-result'), id: count, answer: inboxAnswerSchema }),
  s.object({ type: s.literal('dialog-result'), id: count, answer: dialogAnswerSchema }),
  s.object({ type: s.literal('popup-result'), id: count, answer: popupAnswerSchema }),
  s.object({ type: s.literal('files-result'), id: count, answer: filesAnswerSchema }),
  s.object({ type: s.literal('route-result'), id: count, answer: routeReplySchema }),
  s.object({ type: s.literal('abort'), reason: s.string() }),
  s.object({ type: s.literal('close') }),
])

export const childMessageSchema: Schema<ChildMessage> = s.discriminatedUnion('type', [
  s.object({ type: s.literal('collected'), tests: s.array(registeredTestSchema), modules: s.optional(s.array(s.string())) }),
  s.object({ type: s.literal('collection-failed'), failure: failureSchema }),
  s.object({
    type: s.literal('command'),
    testId: s.string(),
    attemptId: s.string(),
    id: count,
    app: s.string(),
    command: pageCommandSchema,
    location: s.optional(sourceLocationSchema),
    stepId: s.optional(s.string()),
    timeoutMs: count,
    callTimeoutMs: s.optional(s.number({ integer: true, min: 1 })),
  }),
  s.object({ type: s.literal('event'), event: childEventSchema }),
  s.object({ type: s.literal('evaluate'), testId: s.string(), attemptId: s.string(), id: count, call: evaluationCallSchema, location: s.optional(sourceLocationSchema), stepId: s.optional(s.string()) }),
  s.object({
    type: s.literal('inbox'),
    testId: s.string(),
    attemptId: s.string(),
    id: count,
    request: inboxRequestSchema,
    timeoutMs: s.number({ integer: true, min: 1 }),
    location: s.optional(sourceLocationSchema),
    stepId: s.optional(s.string()),
  }),
  s.object({
    type: s.literal('dialog'),
    testId: s.string(),
    attemptId: s.string(),
    id: count,
    app: s.string(),
    request: dialogRequestSchema,
    timeoutMs: s.number({ integer: true, min: 1 }),
    location: s.optional(sourceLocationSchema),
    stepId: s.optional(s.string()),
  }),
  s.object({
    type: s.literal('popup'),
    testId: s.string(),
    attemptId: s.string(),
    id: count,
    app: s.string(),
    request: popupRequestSchema,
    timeoutMs: s.number({ integer: true, min: 1 }),
    location: s.optional(sourceLocationSchema),
    stepId: s.optional(s.string()),
  }),
  s.object({
    type: s.literal('files'),
    testId: s.string(),
    attemptId: s.string(),
    id: count,
    request: filesRequestSchema,
    timeoutMs: s.number({ integer: true, min: 1 }),
    location: s.optional(sourceLocationSchema),
    stepId: s.optional(s.string()),
  }),
  s.object({
    type: s.literal('route'),
    testId: s.string(),
    attemptId: s.string(),
    id: count,
    app: s.string(),
    request: routeRequestSchema,
    timeoutMs: s.number({ integer: true, min: 1 }),
    location: s.optional(sourceLocationSchema),
    stepId: s.optional(s.string()),
  }),
  s.object({
    type: s.literal('test-finished'),
    testId: s.string(),
    attemptId: s.string(),
    status: s.enum(['passed', 'failed']),
    failure: s.optional(failureSchema),
    assertionCount: count,
    durationMs: s.number({ min: 0 }),
    modules: s.optional(s.array(s.string())),
  }),
  s.object({ type: s.literal('process-error'), failure: failureSchema }),
])
