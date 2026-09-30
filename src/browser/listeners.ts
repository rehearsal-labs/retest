/** A set of listeners where one that throws neither stops the others nor reaches the caller. */
export class Listeners<T> {
  readonly #entries = new Set<{ listener: (value: T) => void }>()
  readonly #onError: (error: unknown) => void

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError
  }

  /** Returns a function that removes the listener. */
  add(listener: (value: T) => void): () => void {
    const entry = { listener }
    this.#entries.add(entry)
    return () => {
      this.#entries.delete(entry)
    }
  }

  emit(value: T): void {
    for (const entry of [...this.#entries]) {
      if (!this.#entries.has(entry)) continue
      try {
        entry.listener(value)
      } catch (error) {
        this.#onError(error)
      }
    }
  }

  /** Removes every listener, including any an emit in progress has not reached yet. */
  clear(): void {
    this.#entries.clear()
  }
}
