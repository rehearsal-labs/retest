import type { CdpSession } from './cdp/session.ts'
import type { Dispatch } from './dispatch.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Key } from '../protocol/keys.ts'
import { sendOptions } from './cdp-results.ts'
import { keyStroke } from './keys.ts'

/** A point in the viewport, in CSS pixels. */
export type Point = { x: number; y: number }

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
  await pressKey(session, { kind: 'named', name: 'Delete', shift: false }, deadline, dispatch)
}

/** Presses and releases a key, which goes to whatever holds the keyboard focus. */
export async function pressKey(session: CdpSession, key: Key, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  const { down, up } = keyStroke(key)
  await dispatch.send(session, 'Input.dispatchKeyEvent', down, deadline)
  await dispatch.send(session, 'Input.dispatchKeyEvent', up, deadline)
}

/**
 * Turns the mouse wheel once at the point, by `delta` in the viewport's own pixels. The browser scrolls whatever
 * scrolls under the point, as it does for a person's wheel, and on a touch screen too.
 */
export async function wheelAt(session: CdpSession, point: Point, delta: Point, deadline: Deadline, dispatch: Dispatch): Promise<void> {
  await dispatch.send(session, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: delta.x, deltaY: delta.y }, deadline)
}
