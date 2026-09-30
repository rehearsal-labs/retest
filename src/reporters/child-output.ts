import type { ChildOutput } from '../runner/contract.ts'
import type { Style, Writer } from './style.ts'

export type ChildEchoOptions = { stdout: Writer; stderr: Writer; style: Style }

export type ChildEcho = {
  push(output: ChildOutput): void
  /** Writes what is left of lines that never ended. */
  flush(): void
}

/**
 * Echoes test files' output line by line, dimmed and prefixed with the file, to the matching stream.
 *
 * @example const echo = createChildEcho({ stdout, stderr, style }); echo.push(output)
 */
export function createChildEcho(options: ChildEchoOptions): ChildEcho {
  const partial = new Map<string, { file: string; stream: ChildOutput['stream']; text: string }>()

  const writeLine = (file: string, stream: ChildOutput['stream'], line: string): void => {
    const writer = stream === 'stderr' ? options.stderr : options.stdout
    writer.write(`${options.style.dim(`  ${file} | ${line.replace(/\r$/, '')}`)}\n`)
  }

  return {
    push(output) {
      const key = JSON.stringify([output.stream, output.file])
      const lines = `${partial.get(key)?.text ?? ''}${output.text}`.split('\n')
      const rest = lines.pop() ?? ''
      if (rest === '') partial.delete(key)
      else partial.set(key, { file: output.file, stream: output.stream, text: rest })
      for (const line of lines) writeLine(output.file, output.stream, line)
    },
    flush() {
      for (const { file, stream, text } of partial.values()) writeLine(file, stream, text)
      partial.clear()
    },
  }
}
