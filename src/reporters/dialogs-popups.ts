import type { EventOfType } from './run-record.ts'
import { quoteText } from '../protocol/text.ts'
import { describePage, plural, printable } from './format.ts'

/**
 * A dialog as reports name it: its kind and text, how it was answered, by Retest when the test did not answer it, and
 * how many characters a prompt was given. The text is the page's, so it is quoted and every control character in it,
 * C1 ones included, is escaped.
 *
 * @example describeDialog({ dialog: 'confirm', message: 'Delete this task?', answer: 'accepted', by: 'test' }) // 'confirm "Delete this task?" accepted'
 */
export function describeDialog(event: Pick<EventOfType<'dialog'>, 'dialog' | 'message' | 'answer' | 'by' | 'typed'>): string {
  const text = event.message === '' ? ' dialog' : ` ${printable(quoteText(event.message))}`
  const typed = event.typed === undefined ? '' : ` with ${plural(event.typed, 'character')}`
  return `${event.dialog}${text} ${event.answer}${event.by === 'retest' ? ' by Retest' : ''}${typed}`
}

/**
 * A popup as reports name it once it opened: the app its steps go by, and the first page it opened.
 *
 * @example describePopupOpened({ popup: 'web/popup-1', url: 'http://127.0.0.1:4173/terms', title: 'Terms' }) // 'popup web/popup-1 opened "Terms" at http://127.0.0.1:4173/terms'
 */
export function describePopupOpened(event: Pick<EventOfType<'popup.opened'>, 'popup' | 'url' | 'title'>): string {
  return `popup ${printable(event.popup)} opened ${describePage(event.url, event.title)}`
}

/**
 * A popup that closed without the test closing it.
 *
 * @example describePopupClosed({ session: 'web/popup-1' }) // 'popup web/popup-1 closed itself'
 */
export function describePopupClosed(event: Pick<EventOfType<'popup.closed'>, 'session'>): string {
  return `popup ${printable(event.session ?? 'page')} closed itself`
}
