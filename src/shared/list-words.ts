/**
 * Joins words the way a sentence lists choices, or, with `and`, a set.
 *
 * @example listWords(['human', 'jsonl', 'agent']) // 'human, jsonl or agent'
 */
export function listWords(words: readonly string[], conjunction: 'or' | 'and' = 'or'): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} ${conjunction} ${words.at(-1)}`
}
