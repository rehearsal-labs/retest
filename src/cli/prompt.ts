import { createInterface } from 'node:readline'

/** Asks a person a question. `ask` resolves to undefined when the input ends or Ctrl+C stops it. */
export type Prompt = { readonly isTTY: boolean; ask(question: string): Promise<string | undefined> }

/** A stream a person types into, such as `process.stdin`. */
export type PromptInput = NodeJS.ReadableStream & { readonly isTTY?: boolean }

/**
 * Questions on a terminal, one line each. A terminal in raw mode turns Ctrl+C into a key press, so it is passed
 * on to `interrupt`, and the command stops the way any interrupt stops it.
 *
 * @example const prompt = terminalPrompt(process.stdin, process.stdout, () => process.emit('SIGINT'))
 */
export function terminalPrompt(input: PromptInput, output: NodeJS.WritableStream, interrupt: () => void): Prompt {
  return {
    isTTY: input.isTTY === true,
    ask: (question) =>
      new Promise((resolve) => {
        const lines = createInterface({ input, output, terminal: true })
        let answer: string | undefined
        lines.once('close', () => resolve(answer))
        lines.once('SIGINT', () => {
          lines.close()
          interrupt()
        })
        lines.question(question, (text) => {
          answer = text
          lines.close()
        })
      }),
  }
}
