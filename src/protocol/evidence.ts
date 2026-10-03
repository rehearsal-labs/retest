/**
 * A file a session captured, and whose it is: its `path` in the run folder, POSIX and relative to it; the `app` it
 * shows; `sessionId`, the session that captured it; the test and attempt that held that session; and `capturedAt`,
 * when the capture came back, in ISO 8601. A screenshot is the only kind so far.
 */
export type EvidenceReference = {
  kind: 'screenshot'
  path: string
  app: string
  sessionId: string
  testId: string
  attemptId: string
  capturedAt: string
}

/**
 * The id of the session an attempt gives one of its apps: the attempt's id, then the app's name. An attempt holds
 * one session for each app, and attempt ids are unique within a run, so no two sessions of a run share an id.
 *
 * @example formatSessionId('k3v9q0x2mb', 'web') // 'k3v9q0x2mb:web'
 */
export function formatSessionId(attemptId: string, app: string): string {
  return `${attemptId}:${app}`
}
