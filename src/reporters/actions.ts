import type { ActionKind, PageCommand } from '../protocol/commands.ts'
import type { EventOfType } from './run-record.ts'
import { describeCommand } from '../protocol/commands.ts'
import { printable } from './format.ts'

/** An action as the parent recorded it, whether it completed or failed. */
export type ActionEvent = EventOfType<'action.completed'> | EventOfType<'action.failed'>

/**
 * An action as the test wrote it, for the actions whose kind and locator do not say what they did: a press with its
 * key, a select with its options, a check or an uncheck, and a scroll with its distance. Undefined for any other
 * action, and for an event without what the call needs, which a report then names by its kind and locator.
 *
 * @example describeWrittenAction(event) // "getByLabel('Country').select('Canada')"
 */
export function describeWrittenAction(event: ActionEvent): string | undefined {
  const command = writtenCommand(event)
  return command === undefined ? undefined : printable(describeCommand(command))
}

function writtenCommand(event: ActionEvent): PageCommand | undefined {
  const { locator } = event
  const on = locator === undefined ? {} : { locator }
  switch (event.command) {
    case 'press':
      return event.key === undefined ? undefined : { kind: 'press', ...on, key: event.key }
    case 'select': {
      const { choices, multiple } = event
      if (locator === undefined || choices === undefined) return undefined
      return { kind: 'select', locator, choices, ...(multiple === undefined ? {} : { multiple }) }
    }
    case 'check':
    case 'uncheck':
      return locator === undefined ? undefined : { kind: event.command, locator }
    case 'scroll':
      return event.scroll === undefined ? undefined : { kind: 'scroll', ...on, ...event.scroll }
    default:
      return undefined
  }
}

const settled: Partial<Record<ActionKind, string>> = { select: 'selected', check: 'checked', uncheck: 'unchecked' }

/**
 * What an action's call leaves out: that it found the element already as asked and sent nothing, that it clicked or
 * tapped the control's label, that it tapped, or that its choice was set by script rather than by real input. Each
 * comes only from its event, so a run that recorded none of them shows none.
 *
 * @example actionNotes(event) // ['clicked its label']
 */
export function actionNotes(event: ActionEvent): string[] {
  if (event.changed === false) return [`already ${settled[event.command] ?? 'as asked'}, sent nothing`]
  return [...howItReached(event), ...(event.input === 'script' ? ['set by script'] : [])]
}

function howItReached(event: ActionEvent): string[] {
  const tapped = event.touch === true
  if (event.via === 'label') return [`${tapped ? 'tapped' : 'clicked'} its label`]
  return tapped ? ['tapped'] : []
}
