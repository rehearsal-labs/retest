/**
 * Waits for `promise` at most `timeoutMs`. Resolves with its value, or undefined when the time ran out first. The
 * timer is cleared either way, so a finished race never keeps the process alive.
 *
 * A promise that settles after the deadline is no longer awaited by anyone; its late rejection is caught here so it
 * cannot end the process as an unhandled rejection. The caller already treats that wait as unanswered.
 *
 * @example await within(runner.exit, 30_000) // { exitCode: 0, signal: null }, or undefined after 30 s
 */
export async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  promise.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
