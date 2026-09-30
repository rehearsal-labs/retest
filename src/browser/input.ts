import type { CdpSession } from './cdp/session.ts'
import type { Dispatch } from './dispatch.ts'
import type { Deadline } from '../protocol/deadline.ts'
import { sendOptions } from './cdp-results.ts'

/** A point in the viewport, in CSS pixels. */
export type Point = { x: number; y: number }

const deleteKey = { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }
// A headed browser on macOS edits text from the key's command, which a synthetic key event must carry itself.
const deleteCommands = process.platform === 'darwin' ? ['deleteForward'] : []

/** Moves the mouse to the point, then presses and releases the left button there. */
export async function clickAt(session: CdpSession, point: Point, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }, sendOptions(deadline))
  const press = { ...point, button: 'left', clickCount: 1 }
  await dispatch.send(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...press, buttons: 1 }, deadline)
  await dispatch.send(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...press, buttons: 0 }, deadline)
}

/** Touches the point and lifts the finger there, which a page that emulates a touch screen reads as a tap. */
export async function tapAt(session: CdpSession, point: Point, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  await dispatch.send(session, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }, deadline)
  await dispatch.send(session, 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, deadline)
}

/** Replaces the selection in the focused field with `value`, as typing or pressing Delete would. */
export async function replaceSelection(session: CdpSession, value: string, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  if (value !== '') {
    await dispatch.send(session, 'Input.insertText', { text: value }, deadline)
    return
  }
  await dispatch.send(session, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...deleteKey, commands: deleteCommands }, deadline)
  await dispatch.send(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...deleteKey }, deadline)
}
