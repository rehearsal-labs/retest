import type { OptionChoiceRecord } from '../../protocol/option-choices.ts'
import type { Schema } from '../../protocol/schema.ts'
import type { Key } from '../../protocol/keys.ts'
import { s } from '../../protocol/schema.ts'
import { keyedObserveFunction, selectionFunction } from '../page-scripts.ts'

// Chromium's plan for a select that takes several options moves its focus with a modifier held and toggles options with
// the modifier and Space. WebKit's list on macOS has neither: any arrow key, with or without Command or Control, moves
// the selection itself, and Space toggles nothing. What WebKit's keyboard can do is select one option alone, and widen
// the selection to the options next to it with Shift and the arrows. Every key the page hears as a change, and Retest
// never selects an option nobody asked for, not even for a moment: so the one option selected alone is the first option
// asked for, reached by Home when it is the list's first, or the last asked for, reached by End when it is the list's
// last, and the selection widens from there over the options asked for only. One option before them is passed through
// only when the select already holds it alone, so Home or End changes nothing. The plan comes from the same resolution of
// the locator and the same reading of the choices as the shared plan: the shared selection function's own source, with
// its last step replaced. A set of options apart from each other, or one that touches neither end of the list, has no
// such plan, and is refused by name rather than chosen some other way. An action pinned to one element plans from that
// element only: the key store is the shared keyed look's own source, so the plan reads a pin by the same rule as the
// look that readies each key.

const sharedHead = 'function selection(choices, query, ...elements) {'
const sharedEnding = '  return selectionOf(select, choices)\n}'
const keysStart = '  const elementKeys = () => {'
const keysEnd = '  const isKeyed = (element, key) => elementKeys().keys.get(element) === key\n'

if (!selectionFunction.startsWith(sharedHead) || !selectionFunction.endsWith(sharedEnding)) {
  throw new Error("The shared selection function no longer begins and ends as the WebKit list plan expects; read page-scripts.ts and update src/browser/webkit/select.ts.")
}

const keysFrom = keyedObserveFunction.indexOf(keysStart)
const keysTo = keysFrom === -1 ? -1 : keyedObserveFunction.indexOf(keysEnd, keysFrom)
if (keysTo === -1) {
  throw new Error("The shared keyed look no longer keeps its keys as the WebKit list plan expects; read page-scripts.ts and update src/browser/webkit/select.ts.")
}
const keysHelper = keyedObserveFunction.slice(keysFrom, keysTo + keysEnd.length)

/** What a list plan is given beside the locator: the choices, and the key of the element an action is pinned to. */
export type ListPlanRequest = { readonly choices: readonly OptionChoiceRecord[]; readonly element: string | null }

/**
 * One key of a WebKit list's plan: `Home` or `End`, which select the list's first or last option alone, or an arrow with
 * Shift held, which widens the selection to the option it reaches.
 */
export type ListKey = { key: 'Home' | 'End' | 'ArrowDown' | 'ArrowUp'; shift: boolean }

/**
 * A WebKit list's plan: the keys that select exactly the options asked for, `apart` for options that are not next to
 * each other, `detour` for options that touch neither end of the list, which no key reaches without selecting another
 * first, `unreachable` for an option no key reaches, as a disabled or hidden one, `single` for a select that takes one
 * option, which keeps the shared plan, `lost` when no single select is there, and `moved` when the one select there is
 * not the element the action is pinned to.
 */
export type ListPlan = { status: 'planned'; keys: ListKey[] } | { status: 'apart' } | { status: 'detour' } | { status: 'unreachable' } | { status: 'single' } | { status: 'lost' } | { status: 'moved' }

export const listPlanSchema: Schema<ListPlan> = s.discriminatedUnion('status', [
  s.object({ status: s.literal('planned'), keys: s.array(s.object({ key: s.enum(['Home', 'End', 'ArrowDown', 'ArrowUp']), shift: s.boolean() })) }),
  s.object({ status: s.literal('apart') }),
  s.object({ status: s.literal('detour') }),
  s.object({ status: s.literal('unreachable') }),
  s.object({ status: s.literal('single') }),
  s.object({ status: s.literal('lost') }),
  s.object({ status: s.literal('moved') }),
])

/**
 * Plans the keys that choose a WebKit list's options. It takes a `ListPlanRequest`, then the locator, as the shared
 * selection function takes its choices and the locator.
 */
export const listPlanFunction: string = `function listPlan(request, query, ...elements) {
  const { choices, element: pinned } = request
${keysHelper}${selectionFunction.slice(sharedHead.length, -sharedEnding.length)}
  if (typeof pinned === 'string' && !isKeyed(select, pinned)) return { status: 'moved' }
  if (!select.multiple) return { status: 'single' }
  const chosen = chooseOptions(select, choices)
  if (chosen.status !== 'chosen') return { status: 'lost' }
  const options = [...select.options]
  const reachable = options.filter((option) => !option.matches(':disabled') && getComputedStyle(option).display !== 'none')
  if (options.some((option) => !reachable.includes(option) && (option.selected || chosen.options.includes(option)))) return { status: 'unreachable' }
  const indexes = [...new Set(chosen.options)].map((option) => reachable.indexOf(option)).sort((first, second) => first - second)
  if (indexes.some((index, at) => at > 0 && index !== indexes[at - 1] + 1)) return { status: 'apart' }
  const first = indexes[0]
  const last = indexes[indexes.length - 1]
  const end = reachable.length - 1
  // Home or End on the option the select already holds alone changes nothing, and the arrow then reaches the first one asked for.
  const selected = options.filter((option) => option.selected)
  const alone = (option) => selected.length === 1 && selected[0] === option
  if (first === 0 || (first === 1 && alone(reachable[0]))) {
    const keys = [{ key: 'Home', shift: false }]
    for (let index = 0; index < first; index += 1) keys.push({ key: 'ArrowDown', shift: false })
    for (let index = first; index < last; index += 1) keys.push({ key: 'ArrowDown', shift: true })
    return { status: 'planned', keys }
  }
  if (last === end || (last === end - 1 && alone(reachable[end]))) {
    const keys = [{ key: 'End', shift: false }]
    for (let index = end; index > last; index -= 1) keys.push({ key: 'ArrowUp', shift: false })
    for (let index = last; index > first; index -= 1) keys.push({ key: 'ArrowUp', shift: true })
    return { status: 'planned', keys }
  }
  return { status: 'detour' }
}`

/**
 * A list key as the keyboard sends it.
 *
 * @example listKey({ key: 'ArrowDown', shift: true }) // { kind: 'named', name: 'ArrowDown', held: ['Shift'] }
 */
export function listKey({ key, shift }: ListKey): Key {
  return { kind: 'named', name: key, held: shift ? ['Shift'] : [] }
}
