import type { CaptureSourceName, RecordIdentity } from './identity.ts'

/**
 * A file a session captured, and whose it is: its `path` in the run folder, POSIX and relative to it; its identity, the
 * `app` it shows, `sessionId`, the session that captured it, and the test and attempt that held that session, with
 * `observationId`, the look id the parent gave the capture when it served it to the test file's process as a look,
 * never an id a native session keeps for itself; and `capturedAt`, when the capture came back, in ISO
 * 8601. `capturedElapsedMs` is the same moment on the run's clock, in whole milliseconds since the run started, as
 * events' `elapsedMs` count them, so a screenshot lines up with the events around it; it is absent when the writer did
 * not know the run's clock. `source` says what took it. A screenshot is the only kind so far. A screenshot is pixels:
 * text redaction never reaches it, and a secret a page shows is in it.
 */
export type CaptureReference = { instance: string; generation: number; observationId: string }

export type EvidenceReference = RecordIdentity & {
  kind: 'screenshot'
  path: string
  capturedAt: string
  capturedElapsedMs?: number
  source?: CaptureSourceName
  captureReference?: CaptureReference
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
