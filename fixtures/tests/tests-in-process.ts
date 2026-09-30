let count = 0

/** Counts the tests in this process that asked. Module state lasts as long as the file's process. */
export function countTest(): number {
  count += 1
  return count
}
