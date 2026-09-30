import type { TestResult } from '../../protocol/result.ts'
import type { TestEvent } from '../../reporters/run-record.ts'
import type { Style } from '../../reporters/style.ts'
import type { RunTargets } from '../../reporters/targets.ts'
import { join } from 'node:path'
import { describeLocator } from '../../protocol/locator.ts'
import { secretPlaceholder } from '../../protocol/secret.ts'
import { formatLocation } from '../../protocol/location.ts'
import { describeStateEvent, formatDuration, plural, statusLabel, testTitle } from '../../reporters/format.ts'
import { describeVariant } from '../../reporters/targets.ts'

export type TimelineOptions = { style: Style; runFolder: string; targets: RunTargets }

const timeWidth = 9

/**
 * One test's events as lines, in order: steps, actions, navigations, checks and evidence, each at its
 * time since the test started. A test with a variant names it, and each action names its app.
 *
 * @example stdout.write(renderTimeline(test, events, { style, runFolder, targets }))
 */
export function renderTimeline(test: TestResult, events: TestEvent[], options: TimelineOptions): string {
  const { style } = options
  const label = describeVariant(test.variant, options.targets)
  const variant = label === undefined ? '' : `  ${style.cyan(label)}`
  const heading = `  ${style.bold(testTitle(test.file, test.name, test.describePath))}${variant}  ${style.dim(formatLocation(test.location))}`
  const facts = [statusLabel(test.status), formatDuration(test.durationMs), plural(test.assertionCount, 'check')]
  const summary = `  ${facts.join(' · ')}`
  const start = events[0]?.elapsedMs ?? 0
  const stepNames = new Map<string, string>()
  let depth = 0
  const lines = [heading, summary, '']
  for (const event of events) {
    if (event.type === 'step.finished') depth = Math.max(0, depth - 1)
    const time = style.dim(formatDuration(event.elapsedMs - start).padStart(timeWidth))
    const app = test.variant !== undefined && isPageEvent(event) && event.session !== undefined ? `${style.cyan(event.session)}  ` : ''
    lines.push(`  ${time}  ${'  '.repeat(depth)}${app}${describe(event, stepNames, options)}`)
    if (event.type === 'step.started') {
      stepNames.set(event.stepId, event.name)
      depth++
    }
  }
  if (events.length === 0) lines.push(style.dim('  No events were recorded for this test.'))
  return `${lines.join('\n')}\n`
}

function isPageEvent(event: TestEvent): boolean {
  return event.type === 'action.completed' || event.type === 'action.failed' || event.type === 'navigation'
}

function typed(event: { secret?: string; valueLength?: number }): string {
  if (event.secret !== undefined) return `, ${secretPlaceholder(event.secret)}`
  return event.valueLength === undefined ? '' : `, ${plural(event.valueLength, 'character')}`
}

function describe(event: TestEvent, stepNames: Map<string, string>, options: TimelineOptions): string {
  const { style } = options
  switch (event.type) {
    case 'test.started':
      return 'started'
    case 'step.started':
      return `▸ ${event.name}`
    case 'step.finished': {
      const mark = event.status === 'passed' ? style.green('✓') : style.red('✗')
      return `${mark} ${stepNames.get(event.stepId) ?? event.stepId}  ${style.dim(formatDuration(event.durationMs))}`
    }
    case 'action.completed':
    case 'action.failed': {
      const target = event.locator === undefined ? '' : ` ${describeLocator(event.locator)}`
      const page = event.command === 'goto' && event.pageUrl !== undefined ? ` → ${event.pageUrl}` : ''
      const text = `${event.command}${target}${typed(event)}${page}  ${style.dim(formatDuration(event.durationMs))}`
      return event.type === 'action.failed' ? `${style.red('✗')} ${text}  ${style.red(event.failure.class)}` : text
    }
    case 'navigation':
      return style.dim(`navigated to ${event.url}`)
    case 'state.saved':
    case 'state.restored':
      return describeStateEvent(event)
    case 'assertion.passed':
    case 'assertion.failed': {
      const mark = event.type === 'assertion.passed' ? style.green('✓') : style.red('✗')
      const target = event.locator === undefined ? '' : ` ${describeLocator(event.locator)}`
      const looks = `${formatDuration(event.durationMs)}, ${plural(event.attempts, 'look')}${event.soft === true ? ', soft' : ''}`
      const failed = event.type === 'assertion.failed' ? `  ${style.red(event.failure.class)}` : ''
      return `${mark} ${event.matcher}${target}  ${style.dim(looks)}${failed}`
    }
    case 'evidence.captured':
      return `screenshot ${join(options.runFolder, event.path)}`
    case 'evidence.failed':
      return style.yellow(`screenshot not saved: ${event.message}`)
    case 'test.finished': {
      const duration = event.status === 'not_run' ? '' : `  ${style.dim(formatDuration(event.durationMs))}`
      return `${statusLabel(event.status).toLowerCase()}${duration}`
    }
  }
}
