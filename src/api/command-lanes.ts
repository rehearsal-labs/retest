import type { SourceLocation } from '../protocol/failures.ts'

/** Something a test sent to an app, named the way the test wrote it. */
export type Work = { readonly label: string; readonly location: SourceLocation | undefined }

/**
 * What each app is busy with. An app takes one action at a time, and no action while an assertion looks at
 * it; assertions may look together. Each app keeps its own lane, so two apps may act at once.
 */
export class CommandLanes {
  readonly #actions = new Map<string, Work>()
  readonly #looks = new Map<string, Set<Work>>()

  /** The work on `app` that `kind` would clash with, if any. */
  blocking(app: string, kind: 'action' | 'look'): Work | undefined {
    const action = this.#actions.get(app)
    if (action !== undefined || kind === 'look') return action
    return this.#looks.get(app)?.values().next().value
  }

  startAction(app: string, work: Work): void {
    this.#actions.set(app, work)
  }

  endAction(app: string, work: Work): void {
    if (this.#actions.get(app) === work) this.#actions.delete(app)
  }

  startLook(app: string, work: Work): void {
    const looks = this.#looks.get(app) ?? new Set<Work>()
    looks.add(work)
    this.#looks.set(app, looks)
  }

  endLook(app: string, work: Work): void {
    this.#looks.get(app)?.delete(work)
  }
}
