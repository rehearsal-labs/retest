import type { PendingNavigation } from './actionability.ts'
import type { CdpSession } from './cdp/session.ts'
import type { CaughtChooser, ChooserArm, ResolvedInputFiles } from './contract.ts'
import type { Dispatch } from './dispatch.ts'
import type { IsolatedWorld } from './isolated-world.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { FileRecord } from '../protocol/files.ts'
import type { EmptyStep, LocatorRecipe } from '../protocol/locator.ts'
import type { Schema } from '../protocol/schema.ts'
import { waitBeforeRead } from '../assertions/wait-before-read.ts'
import { describeEmptyStep, describeLocator, describeStep, emptyStepSchema, locatorSteps } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { BrowserError } from './browser-error.ts'
import { CdpProtocolError, CdpTimeoutError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { documentFactsSchema, pageFactsOf } from './document-facts.ts'
import { isGoneContext, worldName } from './isolated-world.ts'
import { locatorArguments } from './locate.ts'
import { originAndPath } from './page-url.ts'
import { locatorHelpers, pageFactsFunction } from './page-scripts.ts'

// File inputs, and the operating system's file picker, on a Chromium page. Files reach an input through
// DOM.setFileInputFiles, which sets them as a person's choice in the picker would and fires the input's own `input` and
// `change` events. The picker is never shown: every page catches each one it opens, and gives it to the test that armed
// for it, or cancels it, so the page hears `cancel` as when a person closes it.

const interceptMethod = 'Page.setInterceptFileChooserDialog'
const openedSchema = s.object({ frameId: s.string(), mode: s.enum(['selectSingle', 'selectMultiple']), backendNodeId: s.optional(s.number({ integer: true })) })
const objectSchema = s.object({ result: s.object({ objectId: s.optional(s.string()) }) })
const resolvedNodeSchema = s.object({ object: s.object({ objectId: s.optional(s.string()) }) })
const worldSchema = s.object({ executionContextId: s.number({ integer: true }) })
const firstPauseMs = 20
const maxPauseMs = 200

const fileSchema = s.object({ name: s.string(), size: s.number({ integer: true, min: 0 }), type: s.string() })

// What Retest's world read of an input that took files: the files its `change` event carried, as the browser made each,
// or null when no change came; the files it holds once the page's own listeners ran; and the page it is on.
const readBackSchema = s.object({ heard: s.nullable(s.array(fileSchema)), held: s.array(fileSchema), page: documentFactsSchema })

/** One look for `setInputFiles`: the one element, ready, and whether it takes several files; or why not yet, or not at all. */
type Readiness =
  | { status: 'ready'; multiple: boolean }
  | { status: 'missing'; empty: EmptyStep | null }
  | { status: 'disabled' }
  | { status: 'ambiguous'; count: number }
  | { status: 'unsupported'; element: string }
  | { status: 'invalid'; step: number; message: string }
  | { status: 'shadow'; host: string }

const readinessSchema: Schema<Readiness> = s.discriminatedUnion('status', [
  s.object({ status: s.literal('ready'), multiple: s.boolean() }),
  s.object({ status: s.literal('missing'), empty: s.nullable(emptyStepSchema) }),
  s.object({ status: s.literal('disabled') }),
  s.object({ status: s.literal('ambiguous'), count: s.number({ integer: true, min: 2 }) }),
  s.object({ status: s.literal('unsupported'), element: s.string() }),
  s.object({ status: s.literal('invalid'), step: s.number({ integer: true, min: 0 }), message: s.string() }),
  s.object({ status: s.literal('shadow'), host: s.string() }),
])

// Finds the one element, takes the control a label names in its place, as a click on the label would reach, and checks
// it is an enabled file input. It need not be visible: an upload input is often hidden behind a button of the page's
// own. A ready input is held in Retest's world, which the page cannot reach, for the call that takes it next.
const inputFilesFunction = `function readyForFiles(query, ...elements) {
  ${locatorHelpers}
  const resolved = resolve(query, elements)
  if (resolved.invalid !== null) return { status: 'invalid', ...resolved.invalid }
  if (typeof resolved.shadow === 'string') return { status: 'shadow', host: resolved.shadow }
  const { found } = resolved
  if (found.length === 0) return { status: 'missing', empty: resolved.empty }
  if (found.length > 1) return { status: 'ambiguous', count: found.length }
  const [first] = found
  const element = first instanceof HTMLLabelElement && first.control !== null ? first.control : first
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    const shown = element instanceof HTMLInputElement ? describe(element).replace('<input', '<input type="' + element.type + '"') : describe(element)
    return { status: 'unsupported', element: shown }
  }
  if (element.matches(':disabled')) return { status: 'disabled' }
  globalThis.retestFileInput = element
  return { status: 'ready', multiple: element.multiple }
}`

// Hands the input the look above held to the caller, once, as an object rather than a value.
const takeInputFunction = `function takeFileInput() {
  const element = globalThis.retestFileInput ?? null
  globalThis.retestFileInput = undefined
  return element
}`

// The browser reads an empty list of paths as a person closing the picker, which leaves the input as it was, so an
// input is cleared from Retest's world, with the events a person clearing it would cause; the page reads them as
// events of its own, whose isTrusted is false.
const clearFunction = `function clearFiles() {
  this.files = new DataTransfer().files
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
}`

// Listens, in Retest's world and on the window's capture, for the input's next `change`, and notes the files it
// carries before the page's listeners on the input run, since a page often clears an input once it has read it.
const listenFunction = `function listenForChange() {
  const input = this
  const heard = (event) => {
    if (event.target === input) globalThis.retestFilesHeard = [...input.files].map((file) => ({ name: file.name, size: file.size, type: file.type }))
  }
  globalThis.retestFilesHeard = null
  globalThis.retestFilesListener = heard
  addEventListener('change', heard, true)
}`

const readBackFunction = `function readFiles() {
  ${locatorHelpers}
  removeEventListener('change', globalThis.retestFilesListener, true)
  const heard = globalThis.retestFilesHeard ?? null
  globalThis.retestFilesHeard = undefined
  globalThis.retestFilesListener = undefined
  return { heard, held: [...this.files].map((file) => ({ name: file.name, size: file.size, type: file.type })), page: pageFacts() }
}`

/**
 * A picker the page caught for a test: the input it opened for, the frame that input is in, the session that reaches
 * that frame, and whether it takes several files.
 */
type Caught = { node: number; frameId: string; session: CdpSession; multiple: boolean }

/**
 * The file pickers of one page. It catches every picker the page opens: the next one after `armFileChooser` goes to the
 * test that armed for it, and every other is cancelled, and counted, so the action that opened it fails. Arming stops
 * the cancelling until a picker opens or the arm is released, and every message to the browser goes in order, so the
 * action an arm was made for meets it.
 */
export class FileChoosers {
  readonly #session: CdpSession
  readonly #mainFrame: () => string
  // The sessions of the page's frames in other processes, which catch the pickers those frames open.
  readonly #frames = new Set<CdpSession>()
  readonly #caught = new Map<string, Caught>()
  #arm: PromiseWithResolvers<CaughtChooser> | undefined
  #enabled = false
  // Pickers nobody armed for, cancelled and not yet told of by a command.
  #unexpected = 0

  constructor(session: CdpSession, mainFrame: () => string) {
    this.#session = session
    this.#mainFrame = mainFrame
    session.on('Page.fileChooserOpened', (params) => this.#opened(params, session))
  }

  /** Whether the page catches its pickers. A browser that does not know how leaves them to itself, and no test can arm for one. */
  get enabled(): boolean {
    return this.#enabled
  }

  /** Starts catching every file picker the page opens, and cancelling it. A browser that answers it does not know how is left as it is. */
  async intercept(deadline: Deadline): Promise<void> {
    try {
      await request(this.#session, interceptMethod, { enabled: true, cancel: true }, s.object({}), sendOptions(deadline))
      this.#enabled = true
    } catch (error) {
      if (!(error instanceof CdpProtocolError)) throw error
    }
  }

  /**
   * Catches the pickers a frame of the page in another process opens, through that frame's own session, as the page's
   * own: the frame's picker goes to an arm, or is cancelled and fails the action that opened it.
   */
  async follow(session: CdpSession, options: { timeoutMs: number }): Promise<void> {
    if (!this.#enabled) return
    session.on('Page.fileChooserOpened', (params) => this.#opened(params, session))
    session.onDetach(() => this.#frames.delete(session))
    this.#frames.add(session)
    await session.send(interceptMethod, { enabled: true, cancel: this.#arm === undefined }, options)
  }

  /**
   * Arms the page for the next file picker it opens. A page holds one arm at a time: arming again while one waits
   * fails the new arm's picker at once, and leaves the first as it was.
   */
  armFileChooser(): ChooserArm {
    const arm = Promise.withResolvers<CaughtChooser>()
    // A refused arm's promise is read only by the caller, which may give up on it first.
    arm.promise.catch(() => undefined)
    if (!this.#enabled) {
      arm.reject(new BrowserError({ class: 'unsupported', message: 'This browser does not let Retest catch a file picker, so Retest waited for none.' }))
      return { opened: arm.promise, release: () => undefined }
    }
    if (this.#arm !== undefined) {
      arm.reject(new BrowserError({ class: 'usage', message: 'page.fileChooser() is already waiting for a file picker on this page. Await it before you wait for the next.' }))
      return { opened: arm.promise, release: () => undefined }
    }
    this.#arm = arm
    this.#cancelling(false)
    return {
      opened: arm.promise,
      release: () => {
        if (this.#arm !== arm) return
        this.#arm = undefined
        this.#cancelling(true)
      },
    }
  }

  /**
   * Runs one of the page's commands, and fails an action during which the page opened a picker nobody armed for, or
   * one that comes after such a picker opened since the last action ended, before anything is sent. A look is run as
   * it is: it sends no input, so it opens no picker.
   */
  async around(action: boolean, describe: () => string, run: () => Promise<CommandResult>): Promise<CommandResult> {
    if (!action) return run()
    if (this.#take() > 0) return { ok: false, failure: pickerBefore(describe()) }
    const result = await run()
    return this.#take() > 0 && result.ok ? { ok: false, failure: pickerDuring(describe()) } : result
  }

  /** Gives the input of a picker this page caught the files, then reads back what it holds. */
  async setFiles(command: Extract<ResolvedInputFiles, { kind: 'setChooserFiles' }>, world: IsolatedWorld, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
    const caught = this.#caught.get(command.chooser)
    const described = 'give the file picker files'
    if (caught === undefined) return { ok: false, failure: { class: 'usage', message: `Could not ${described}: it is not a picker this page caught, so Retest gave it nothing.`, details: { inputSent: false } } }
    if (command.paths.length > 1 && !caught.multiple) return { ok: false, failure: oneFileOnly(described, command.paths.length) }
    // The input is read in Retest's own world of its frame, where no script of the page can change what it reports.
    const { session } = caught
    const context = await this.#worldOf(caught, world, deadline)
    if (context === undefined) {
      const message = `Could not ${described}: the frame its input is in is gone from the page, so Retest gave it nothing.`
      return { ok: false, failure: { class: 'not_actionable', message, details: { inputSent: false } } }
    }
    const objectGroup = `retest-files-${command.chooser}`
    try {
      const objectId = await this.#resolve(caught, context, objectGroup, deadline)
      if (objectId === undefined) {
        const message = `Could not ${described}: the input it opened for is gone from the page, so Retest gave it nothing.`
        return { ok: false, failure: { class: 'not_actionable', message, details: { inputSent: false } } }
      }
      return await giveFiles({ session, objectId, command, deadline, dispatch })
    } finally {
      releaseGroup(session, objectGroup)
    }
  }

  // Retest's world of the main frame is the page's own; any other frame, of the page's process or of another reached
  // through its own session, is given a world of Retest's for the call. Undefined once the frame is gone.
  async #worldOf({ frameId, session }: Caught, world: IsolatedWorld, deadline: Deadline): Promise<number | undefined> {
    if (session === this.#session && frameId === this.#mainFrame()) return (await world.enter(pageFactsFunction, [], documentFactsSchema, deadline)).context
    try {
      return (await request(session, 'Page.createIsolatedWorld', { frameId, worldName }, worldSchema, sendOptions(deadline))).executionContextId
    } catch (error) {
      if (error instanceof CdpProtocolError) return undefined
      throw error
    }
  }

  // A node that has gone, with its document, resolves to nothing.
  async #resolve({ node: backendNodeId, session }: Caught, executionContextId: number, objectGroup: string, deadline: Deadline): Promise<string | undefined> {
    try {
      const { object } = await request(session, 'DOM.resolveNode', { backendNodeId, executionContextId, objectGroup }, resolvedNodeSchema, sendOptions(deadline))
      return object.objectId
    } catch (error) {
      if (error instanceof CdpProtocolError) return undefined
      throw error
    }
  }

  #opened(params: unknown, session: CdpSession): void {
    const { frameId, mode, backendNodeId } = readProtocol(openedSchema, params, { method: 'Page.fileChooserOpened', sessionId: session.id })
    const arm = this.#arm
    if (arm === undefined) {
      this.#unexpected += 1
      return
    }
    this.#arm = undefined
    this.#cancelling(true)
    if (backendNodeId === undefined) {
      const message = 'The page opened a file picker that belongs to no <input type="file">, as showOpenFilePicker() opens, and Retest gives files only to an input.'
      arm.reject(new BrowserError({ class: 'unsupported', message }))
      return
    }
    const id = `chooser-${this.#caught.size + 1}`
    const multiple = mode === 'selectMultiple'
    this.#caught.set(id, { node: backendNodeId, frameId, session, multiple })
    arm.resolve({ id, multiple })
  }

  #take(): number {
    const count = this.#unexpected
    this.#unexpected = 0
    return count
  }

  // Sent without waiting: messages to the browser go in order, so the change reaches it before the next command. Each
  // frame of another process is told through its own session.
  #cancelling(cancel: boolean): void {
    for (const session of [this.#session, ...this.#frames]) {
      session.send(interceptMethod, { enabled: true, cancel }).catch(() => {
        // A page or a frame that is gone has no picker left to catch.
      })
    }
  }
}

/** What `setInputFiles` needs of the page: its world and session, and the navigation it is on, if any. */
export type InputFilesContext = {
  world: IsolatedWorld
  session: CdpSession
  pendingNavigation: () => PendingNavigation | undefined
}

/**
 * Gives the one file input a locator finds the files, once it is there and enabled, and reads back what it holds. A
 * locator that finds a label gives the control the label names. Visibility is not checked. More than one match, an
 * element that is not a file input, and more files than the input takes fail at once; anything else waits for the
 * deadline. While the browser is opening another document, the page is not looked at.
 *
 * @example const result = await setInputFiles({ world, session, pendingNavigation }, command, deadline, dispatch)
 */
export async function setInputFiles(page: InputFilesContext, command: Extract<ResolvedInputFiles, { kind: 'setInputFiles' }>, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const { world, session, pendingNavigation } = page
  const { locator } = command
  const described = `set the files of ${describeLocator(locator)}`
  let last: Unready = { status: 'missing', empty: null }
  for (let attempt = 0; ; attempt += 1) {
    const finalRead = deadline.reached
    const pending = pendingNavigation()
    const looked: Looked = pending === undefined ? await lookFor(world, locator, deadline, last) : { status: 'navigating', url: pending.url }
    if (looked.status === 'ready') {
      if (command.paths.length > 1 && !looked.multiple) return { ok: false, failure: oneFileOnly(described, command.paths.length) }
      const given = await giveHeld(session, looked.context, { command, deadline, dispatch })
      if (given !== undefined) return given
      last = { status: 'missing', empty: null }
    } else if (looked.status === 'missing' || looked.status === 'disabled' || looked.status === 'navigating') {
      last = looked
    } else {
      return { ok: false, failure: settledFailure(looked, locator, described) }
    }
    if (finalRead) return { ok: false, failure: unready(last, locator, described, deadline.budgetMs) }
    await waitBeforeRead(deadline, Math.min(firstPauseMs * 2 ** attempt, maxPauseMs))
  }
}

/** Why the input was not ready on the last look: still missing or disabled, or the page still opening another document. */
type Unready = Extract<Readiness, { status: 'missing' | 'disabled' }> | { status: 'navigating'; url: string }

type Looked = (Extract<Readiness, { status: 'ready' }> & { context: number }) | Exclude<Readiness, { status: 'ready' }> | Unready

// A look that times out keeps the reason of the look before it, and the loop looks again until the deadline.
async function lookFor(world: IsolatedWorld, locator: LocatorRecipe, deadline: Deadline, last: Unready): Promise<Looked> {
  try {
    const { value, context } = await world.enter(inputFilesFunction, locatorArguments(locator, []), readinessSchema, deadline)
    return value.status === 'ready' ? { ...value, context } : value
  } catch (error) {
    if (error instanceof CdpTimeoutError) return last
    throw error
  }
}

type Giving = { command: ResolvedInputFiles; deadline: Deadline; dispatch: Dispatch }

// The input the look held, as an object in the document it was found in. Undefined when that document went away, or
// the input with it, before it could be taken: the input is then looked for again.
async function giveHeld(session: CdpSession, context: number, giving: Giving): Promise<CommandResult | undefined> {
  const objectGroup = `retest-files-${context}`
  try {
    const params = { functionDeclaration: takeInputFunction, executionContextId: context, returnByValue: false, objectGroup }
    let taken: { result: { objectId?: string | undefined } }
    try {
      taken = await request(session, 'Runtime.callFunctionOn', params, objectSchema, sendOptions(giving.deadline))
    } catch (error) {
      if (isGoneContext(error)) return undefined
      throw error
    }
    const { objectId } = taken.result
    if (objectId === undefined) return undefined
    return await giveFiles({ session, objectId, ...giving })
  } finally {
    releaseGroup(session, objectGroup)
  }
}

// The files go to the input once. The browser confirms them and fires the input's `change`, which is the action's
// outcome: `files` are those the event carried, as the browser named, sized and typed each, and `kept` what the input
// holds once the page's own listeners ran, when that differs, as when a page clears an input it has read. A type the
// test named that the browser did not give fails, since the page reads the browser's.
async function giveFiles({ session, objectId, command, deadline, dispatch }: Giving & { session: CdpSession; objectId: string }): Promise<CommandResult> {
  await session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: listenFunction }, sendOptions(deadline))
  if (command.paths.length === 0) await dispatch.send(session, 'Runtime.callFunctionOn', { objectId, functionDeclaration: clearFunction }, deadline)
  else await dispatch.send(session, 'DOM.setFileInputFiles', { files: command.paths, objectId }, deadline)
  const params = { objectId, functionDeclaration: readBackFunction, returnByValue: true }
  const raw = await session.send('Runtime.callFunctionOn', params, sendOptions(deadline))
  const { heard, held, page } = readProtocol(s.object({ result: s.object({ value: readBackSchema }) }), raw, { method: 'Runtime.callFunctionOn', sessionId: session.id }).result.value
  const given = (heard ?? held).map(fileRecord)
  const after = held.map(fileRecord)
  const kept = JSON.stringify(after) === JSON.stringify(given) ? {} : { kept: after }
  const typed = command.mimeTypes.findIndex((type, index) => type !== null && given[index] !== undefined && given[index].type !== type)
  const wrong = given[typed]
  if (wrong !== undefined) {
    const given = wrong.type === undefined ? 'no type' : `the type ${wrong.type}`
    const message = `The browser gave ${wrong.name} ${given}, not ${command.mimeTypes[typed] ?? ''}: it types a file by the end of its name. Name the file so its type comes out as asked.`
    return { ok: false, failure: { class: 'usage', message, details: { inputSent: true } } }
  }
  return { ok: true, kind: command.kind, files: given, ...kept, page: pageFactsOf(page) }
}

function fileRecord({ name, size, type }: { name: string; size: number; type: string }): FileRecord {
  return type === '' ? { name, size } : { name, size, type }
}

function releaseGroup(session: CdpSession, objectGroup: string): void {
  session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {
    // The objects go with their document, so a release that fails holds them only until it closes.
  })
}

// A look that settles the command as a failure at once: what it finds can never take the files.
function settledFailure(looked: Extract<Readiness, { status: 'ambiguous' | 'unsupported' | 'invalid' | 'shadow' }>, locator: LocatorRecipe, described: string): Failure {
  switch (looked.status) {
    case 'ambiguous':
      return { class: 'ambiguous', message: `Could not ${described}: it matches ${looked.count} elements, and a locator must match exactly one. Retest gave none of them files.`, details: { count: looked.count } }
    case 'unsupported': {
      const message = `Could not ${described}: it is ${looked.element}, and setInputFiles() gives files to an <input type="file">. For a button that opens a file picker, use page.fileChooser().`
      return { class: 'not_actionable', message, details: { element: looked.element, inputSent: false } }
    }
    case 'invalid': {
      const step = locatorSteps(locator)[looked.step]
      const selector = step === undefined ? describeLocator(locator) : describeStep(step, locator.dialect)
      return { class: 'usage', message: `Could not ${described}: the page cannot read the CSS selector in ${selector}. ${looked.message}`, details: { selector } }
    }
    case 'shadow':
      return {
        class: 'unsupported',
        message: `Could not ${described}: the page holds an open shadow root, in ${looked.host}. Playwright looks inside shadow roots and Retest does not, so Retest refuses the lookup rather than find less than Playwright would.`,
        details: { host: looked.host },
      }
  }
}

function unready(last: Unready, locator: LocatorRecipe, described: string, waitedMs: number): Failure {
  switch (last.status) {
    case 'missing': {
      const step = last.empty === null ? undefined : describeEmptyStep(locator, last.empty)
      return { class: 'not_found', message: `Could not ${described}: no element matched within ${waitedMs} ms.${step === undefined ? '' : ` ${step}`}`, details: { waitedMs } }
    }
    case 'disabled':
      return { class: 'not_actionable', message: `Could not ${described} within ${waitedMs} ms: it is disabled.`, details: { check: 'enabled', waitedMs } }
    case 'navigating': {
      const parsed = URL.parse(last.url)
      const opening = parsed === null ? last.url : originAndPath(parsed)
      const message = `Could not ${described} within ${waitedMs} ms: the page was still opening ${opening}, and Retest gives no files in a document about to be replaced.`
      return { class: 'not_actionable', message, details: { check: 'navigation', url: opening, waitedMs } }
    }
  }
}

function oneFileOnly(described: string, given: number): Failure {
  const message = `Could not ${described}: it takes one file, and it was given ${given}. Pass one file, or add the multiple attribute to the input.`
  return { class: 'usage', message, details: { files: given, inputSent: false } }
}

// Each caller says what it can do about a picker, since a test, a Playwright test file and an agent session can each do
// something else: `withPickerAdvice` adds it.
function pickerDuring(described: string): Failure {
  const message = `The page opened a file picker as Retest went to ${described}, and nothing was waiting for one. Retest closed the picker.`
  return { class: 'not_actionable', message, details: { picker: 'file', inputSent: true } }
}

function pickerBefore(described: string): Failure {
  const message = `The page opened a file picker after the action before this one, and nothing was waiting for one. Retest closed the picker, and did not ${described}.`
  return { class: 'not_actionable', message, details: { picker: 'file', inputSent: false } }
}

/**
 * A command's answer with `advice` after the failure a file picker nobody waited for gave it, saying what the caller
 * can do about such a picker. Any other answer is returned as it is.
 *
 * @example withPickerAdvice(result, 'This agent session cannot give a page files.')
 */
export function withPickerAdvice(result: CommandResult, advice: string): CommandResult {
  if (result.ok || result.failure.details?.['picker'] !== 'file') return result
  return { ok: false, failure: { ...result.failure, message: `${result.failure.message} ${advice}` } }
}

/**
 * The failure of a command about files on a page whose engine does not run it yet, naming where it was asked.
 *
 * @example filesRefused('upload', 'on Firefox').class // 'unsupported'
 */
export function filesRefused(what: 'upload' | 'chooser' | 'download', where: string): Failure {
  switch (what) {
    case 'upload':
      return { class: 'unsupported', message: `Retest gives a file input files on Chrome and Chromium only, and not ${where} yet, so it gave none.`, details: { inputSent: false } }
    case 'chooser':
      return { class: 'unsupported', message: `Retest catches a file picker on Chrome and Chromium only, and not ${where} yet, so it waited for none.` }
    case 'download':
      return { class: 'unsupported', message: `Retest saves downloads on Chrome and Chromium only, and not ${where} yet, so it waited for none.` }
  }
}
