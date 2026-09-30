export type DiffLine = { kind: 'same' | 'expected' | 'received'; text: string }

// Beyond this many line pairs the table costs more than the diff is worth; both sides are shown whole.
const maxCells = 250_000

/**
 * The lines of two texts, marked as only expected, only received, or in both, in order.
 *
 * @example diffLines('a\nb', 'a\nc') // same a, expected b, received c
 */
export function diffLines(expected: string, received: string): DiffLine[] {
  const left = splitLines(expected)
  const right = splitLines(received)
  if (left.length * right.length > maxCells) {
    return [...left.map((text) => line('expected', text)), ...right.map((text) => line('received', text))]
  }
  const common = commonLengths(left, right)
  const width = right.length + 1
  const at = (row: number, column: number): number => common[row * width + column] ?? 0
  const lines: DiffLine[] = []
  let row = 0
  let column = 0
  while (row < left.length || column < right.length) {
    const leftText = left[row]
    const rightText = right[column]
    if (leftText !== undefined && leftText === rightText) {
      lines.push(line('same', leftText))
      row++
      column++
    } else if (rightText === undefined || (leftText !== undefined && at(row + 1, column) >= at(row, column + 1))) {
      lines.push(line('expected', leftText ?? ''))
      row++
    } else {
      lines.push(line('received', rightText))
      column++
    }
  }
  return lines
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

// Longest common subsequence lengths of every pair of suffixes, row-major.
function commonLengths(left: string[], right: string[]): Uint32Array {
  const width = right.length + 1
  const table = new Uint32Array((left.length + 1) * width)
  for (let row = left.length - 1; row >= 0; row--) {
    for (let column = right.length - 1; column >= 0; column--) {
      const index = row * width + column
      table[index] =
        left[row] === right[column]
          ? (table[index + width + 1] ?? 0) + 1
          : Math.max(table[index + width] ?? 0, table[index + 1] ?? 0)
    }
  }
  return table
}

function line(kind: DiffLine['kind'], text: string): DiffLine {
  return { kind, text }
}
