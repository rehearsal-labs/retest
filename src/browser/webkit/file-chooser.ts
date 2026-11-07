import type { CaughtChooser, ChooserArm, ResolvedInputFiles } from '../contract.ts'
import type { Dispatch } from '../dispatch.ts'
import type { CommandResult } from '../../protocol/commands.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { WebKitTargetSession } from './target-session.ts'
import { s } from '../../protocol/schema.ts'
import { BrowserError } from '../browser-error.ts'
import { readProtocol } from '../cdp-results.ts'
import { giveFiles, oneFileOnly } from '../file-chooser.ts'
import { isGoneContext } from '../isolated-world.ts'

// The file picker on a WebKit page. Every page target is set up with `Page.setInterceptFileChooserDialog`, so WebKit
// shows no picker at all and tells of each one in `Page.fileChooserOpened`, naming the input it opened for as an object
// of the page's own main world. The one a test armed for is made an object of Retest's world of the input's frame, where
// the page's scripts cannot change what it reports, and given its files there as an input `setInputFiles` found is.
// WebKit's protocol has no way to close a picker, and its build tells the page nothing of one it intercepted: the page
// hears no `cancel`, whether a test waited for the picker or not (probe on build 2359: three caught pickers, no event).

const openedSchema = s.object({ frameId: s.string(), element: s.object({ objectId: s.optional(s.string()) }) })
const multipleSchema = s.object({ result: s.object({ value: s.boolean() }) })

// Reads, in Retest's world, whether the input takes several files.
const multipleFunction = 'function multiple() { return this.multiple === true }'

/** A picker this page caught for a test: its input, as an object of Retest's world of its frame, and whether it takes several files. */
type Caught = { readonly objectId: string; readonly multiple: boolean }

/**
 * The file pickers of one WebKit page. The next picker after `armFileChooser` goes to the test that armed for it; every
 * other one is counted, so the action that opened it fails, and is let go.
 */
export class WebKitFileChoosers {
  readonly #bridge: WebKitTargetSession
  readonly #setupMs: number
  readonly #caught = new Map<string, Caught>()
  #arm: PromiseWithResolvers<CaughtChooser> | undefined
  // Pickers nobody armed for, not yet told of by a command.
  #unexpected = 0
  #taken = 0

  constructor(bridge: WebKitTargetSession, setupMs: number) {
    this.#bridge = bridge
    this.#setupMs = setupMs
  }

  /**
   * Arms the page for the next file picker it opens. A page holds one arm at a time: arming again while one waits fails
   * the new arm's picker at once, and leaves the first as it was.
   */
  armFileChooser(): ChooserArm {
    const arm = Promise.withResolvers<CaughtChooser>()
    // A refused arm's promise is read only by the caller, which may give up on it first.
    arm.promise.catch(() => undefined)
    if (this.#arm !== undefined) {
      arm.reject(new BrowserError({ class: 'usage', message: 'page.fileChooser() is already waiting for a file picker on this page. Await it before you wait for the next.' }))
      return { opened: arm.promise, release: () => undefined }
    }
    this.#arm = arm
    return {
      opened: arm.promise,
      release: () => {
        if (this.#arm === arm) this.#arm = undefined
      },
    }
  }

  /**
   * Runs one of the page's commands, and fails an action during which the page opened a picker nobody armed for, or one
   * that comes after such a picker opened since the last action ended, before anything is sent. A look sends no input,
   * so it opens no picker, and runs as it is.
   */
  async around(action: boolean, describe: () => string, run: () => Promise<CommandResult>): Promise<CommandResult> {
    if (!action) return run()
    if (this.#take() > 0) return { ok: false, failure: pickerBefore(describe()) }
    const result = await run()
    return this.#take() > 0 && result.ok ? { ok: false, failure: pickerDuring(describe()) } : result
  }

  /**
   * The page's committed target told of a picker. An armed one is handed over once its input is an object of Retest's
   * world, read there for whether it takes several files; any other is counted, and its object let go.
   */
  opened(params: unknown): void {
    const { frameId, element } = readProtocol(openedSchema, params, { method: 'Page.fileChooserOpened', sessionId: this.#bridge.session.id })
    const arm = this.#arm
    if (arm === undefined) {
      this.#unexpected += 1
      if (element.objectId !== undefined) this.#bridge.release(element.objectId)
      return
    }
    this.#arm = undefined
    if (element.objectId === undefined) {
      arm.reject(new BrowserError({ class: 'unsupported', message: 'The page opened a file picker that WebKit names no <input type="file"> for, and Retest gives files only to an input.' }))
      return
    }
    void this.#hand(arm, element.objectId, frameId)
  }

  /** Gives the input of a picker this page caught the files, then reads back what it holds. */
  async setFiles(command: Extract<ResolvedInputFiles, { kind: 'setChooserFiles' }>, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
    const caught = this.#caught.get(command.chooser)
    const described = 'give the file picker files'
    if (caught === undefined) return { ok: false, failure: { class: 'usage', message: `Could not ${described}: it is not a picker this page caught, so Retest gave it nothing.`, details: { inputSent: false } } }
    if (command.paths.length > 1 && !caught.multiple) return { ok: false, failure: oneFileOnly(described, command.paths.length) }
    try {
      return await giveFiles({ session: this.#bridge.session, objectId: caught.objectId, command, deadline, dispatch })
    } catch (error) {
      // The object went with its document, or its frame, before anything was sent to it.
      if (!dispatch.sent && isGoneContext(error)) return { ok: false, failure: inputGone(described) }
      throw error
    }
  }

  async #hand(arm: PromiseWithResolvers<CaughtChooser>, pageObject: string, frameId: string): Promise<void> {
    this.#taken += 1
    const id = `chooser-${this.#taken}`
    try {
      const objectId = await this.#bridge.adopt(pageObject, frameId, `retest-${id}`, { timeoutMs: this.#setupMs })
      if (objectId === undefined) {
        arm.reject(new BrowserError(inputGone('hand over the file picker')))
        return
      }
      const raw = await this.#bridge.session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: multipleFunction, returnByValue: true }, { timeoutMs: this.#setupMs })
      const multiple = readProtocol(multipleSchema, raw, { method: 'Runtime.callFunctionOn', sessionId: this.#bridge.session.id }).result.value
      this.#caught.set(id, { objectId, multiple })
      arm.resolve({ id, multiple })
    } catch (error) {
      arm.reject(isGoneContext(error) ? new BrowserError(inputGone('hand over the file picker')) : error)
    } finally {
      this.#bridge.release(pageObject)
    }
  }

  #take(): number {
    const count = this.#unexpected
    this.#unexpected = 0
    return count
  }
}

function inputGone(described: string): Failure {
  return { class: 'not_actionable', message: `Could not ${described}: the input it opened for is gone from the page, so Retest gave it nothing.`, details: { inputSent: false } }
}

// WebKit never shows the picker and tells the page nothing of it, so the page hears no cancel. Each caller says what it
// can do about such a picker: `withPickerAdvice` reads `details.picker` to add it.
function pickerDuring(described: string): Failure {
  const message = `The page opened a file picker as Retest went to ${described}, and nothing was waiting for one. WebKit did not show it, and tells the page nothing of it, not even cancel.`
  return { class: 'not_actionable', message, details: { picker: 'file', inputSent: true } }
}

function pickerBefore(described: string): Failure {
  const message = `The page opened a file picker after the action before this one, and nothing was waiting for one. WebKit did not show it, and Retest did not ${described}.`
  return { class: 'not_actionable', message, details: { picker: 'file', inputSent: false } }
}
