import { s, type Schema } from './schema.ts'

/**
 * Whose a record is, by the keys every record that came from a session shares: the test and the attempt that held the
 * session, the app it is of, the session's id, as `formatSessionId` writes it, and the look the record rests on, where
 * it rests on one, by the id the parent gave that look when it served it to the test file's process. A screenshot, a frame, a diagnostics record and an AI check's evidence carry these keys under these
 * names, so one reader can join them. An event carries the same keys, except that it names the app in `session`, as
 * events always have. A field is present only when the writer knew it; none is made up.
 *
 * @example const identity: RecordIdentity = { testId: 'tests/tasks.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }
 */
export type RecordIdentity = {
  testId: string
  attemptId: string
  app: string
  sessionId: string
  observationId?: string
}

/**
 * What took a capture: `chromium`, a Chromium page's own capture over the DevTools protocol, an Electron window's
 * among them; or a native session's source, as it names its own: `executor-screen`, the executor's screenshot of the
 * device; `simulator-display`, the simulator's display; `window-crop`, the app's window cut from the Mac's display.
 */
export type CaptureSourceName = 'chromium' | 'executor-screen' | 'simulator-display' | 'window-crop'

export const captureSourceNameSchema: Schema<CaptureSourceName> = s.enum(['chromium', 'executor-screen', 'simulator-display', 'window-crop'])
