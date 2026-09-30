/**
 * The candidate closest to `input`, when it is close enough to be a typo.
 *
 * @example suggest('rn', ['list', 'run', 'inspect']) // 'run'
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance && distance <= Math.max(1, Math.floor(candidate.length / 3))) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

// Optimal string alignment: insertions, deletions, substitutions and swaps of neighbours each cost one.
function editDistance(left: string, right: string): number {
  let previousRow: number[] = []
  let row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    const nextRow = [i]
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      let distance = Math.min((row[j] ?? 0) + 1, (nextRow[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        distance = Math.min(distance, (previousRow[j - 2] ?? 0) + 1)
      }
      nextRow.push(distance)
    }
    previousRow = row
    row = nextRow
  }
  return row[right.length] ?? 0
}
