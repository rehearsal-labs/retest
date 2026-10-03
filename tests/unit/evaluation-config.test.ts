import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { defaultEvaluationLimits } from '../../src/evaluation/budget.ts'
import { validateConfig } from '../../src/config/validate.ts'

const apps = { web: { browser: 'chromium' } }
const judge = { adapter: './judges/visual.ts', accepts: ['text', 'images'] }

function problems(evaluation: unknown): string {
  const validated = validateConfig({ apps, evaluation }, '/work/retest.config.ts')
  assert.equal(validated.ok, false, 'the config is refused')
  return validated.ok ? '' : validated.failure.message
}

describe('the evaluation block', () => {
  test('reads judges, the default judge, the time a check may take and the limits, each with its default', () => {
    const credential = (): string => 'sk-from-a-vault'
    const validated = validateConfig(
      {
        apps,
        evaluation: {
          judges: {
            visual: { adapter: './judges/visual.ts', credentials: { apiKey: { env: 'ANTHROPIC_API_KEY' }, project: credential }, options: { provider: 'anthropic', model: 'claude-sonnet-5', nested: { list: [1, 'two', null] } }, accepts: ['text', 'images'] },
            words: { adapter: '@rehearsal-labs/retest/evaluation/ai-sdk', accepts: ['text'] },
          },
          defaultJudge: 'visual',
          timeoutMs: 20_000,
          limits: { callsPerRun: 10 },
        },
      },
      '/work/retest.config.ts',
    )
    assert.ok(validated.ok, validated.ok ? '' : validated.failure.message)
    const evaluation = validated.config.evaluation
    assert.ok(evaluation !== undefined)
    const visual = evaluation.judges.get('visual')
    assert.deepEqual(visual?.adapter, { kind: 'file', path: '/work/judges/visual.ts' })
    assert.deepEqual(evaluation.judges.get('words')?.adapter, { kind: 'package', specifier: '@rehearsal-labs/retest/evaluation/ai-sdk', from: '/work/retest.config.ts' })
    assert.deepEqual(visual?.credentials.get('apiKey'), { env: 'ANTHROPIC_API_KEY' })
    assert.ok(visual?.credentials.get('project') !== undefined && 'read' in (visual.credentials.get('project') ?? {}))
    assert.deepEqual(visual?.options, { provider: 'anthropic', model: 'claude-sonnet-5', nested: { list: [1, 'two', null] } })
    assert.deepEqual(visual?.accepts, ['text', 'images'])
    assert.equal(evaluation.defaultJudge, 'visual')
    assert.equal(evaluation.timeoutMs, 20_000)
    assert.deepEqual(evaluation.limits, { ...defaultEvaluationLimits, callsPerRun: 10 })
  })

  test('takes the only judge as the default, and gives a check 30 seconds and the default limits', () => {
    const validated = validateConfig({ apps, evaluation: { judges: { visual: judge } } }, '/work/retest.config.ts')
    assert.ok(validated.ok)
    assert.equal(validated.config.evaluation?.defaultJudge, 'visual')
    assert.equal(validated.config.evaluation?.timeoutMs, 30_000)
    assert.deepEqual(validated.config.evaluation?.limits, defaultEvaluationLimits)
  })

  test('takes a factory as the adapter, which the parent calls itself', () => {
    const validated = validateConfig({ apps, evaluation: { judges: { visual: { adapter: () => ({}), accepts: ['images'] } } } }, '/work/retest.config.ts')
    assert.ok(validated.ok)
    assert.equal(validated.config.evaluation?.judges.get('visual')?.adapter.kind, 'factory')
  })

  test('a config without it has no evaluation, and its runs no AI checks', () => {
    const validated = validateConfig({ apps }, '/work/retest.config.ts')
    assert.ok(validated.ok)
    assert.equal(validated.config.evaluation, undefined)
  })

  test('refuses an unknown key at every level', () => {
    const message = problems({ judges: { visual: { ...judge, model: 'x' } }, retries: 2, limits: { callsPerHour: 3 } })
    assert.match(message, /evaluation\.judges\.visual\.model: unknown key/)
    assert.match(message, /evaluation\.retries: unknown key/)
    assert.match(message, /evaluation\.limits\.callsPerHour: unknown key, expected/)
  })

  test('refuses a default judge that is not declared', () => {
    assert.match(problems({ judges: { visual: judge }, defaultJudge: 'visul' }), /evaluation\.defaultJudge: expected "visual", received "visul"/)
  })

  test('refuses a credential given as its value, and never quotes it', () => {
    const message = problems({ judges: { visual: { ...judge, credentials: { apiKey: 'sk-live-0123456789' } } } })
    assert.match(message, /evaluation\.judges\.visual\.credentials\.apiKey: expected env\("NAME"\) or a function that returns the credential, received a string\. Credentials are never written into the config/)
    assert.doesNotMatch(message, /sk-live/)
    assert.doesNotMatch(problems({ judges: { visual: { ...judge, credentials: { apiKey: { value: 'sk-live-0123456789' } } } } }), /sk-live/)
    assert.match(problems({ judges: { visual: { ...judge, credentials: { apiKey: { env: 'not a name' } } } } }), /credentials\.apiKey\.env: expected an environment variable name/)
  })

  test('refuses options that are not JSON, an adapter that is neither a path nor a function, and a judge that says nothing of what it takes', () => {
    assert.match(problems({ judges: { visual: { ...judge, options: { onAnswer: () => 1 } } } }), /evaluation\.judges\.visual\.options\.onAnswer: expected a JSON value, received function/)
    assert.match(problems({ judges: { visual: { ...judge, options: { temperature: Number.NaN } } } }), /options\.temperature: expected a finite number/)
    assert.match(problems({ judges: { visual: { accepts: ['text'] } } }), /evaluation\.judges\.visual\.adapter: missing required key/)
    assert.match(problems({ judges: { visual: { adapter: './judge.ts' } } }), /evaluation\.judges\.visual\.accepts: missing required key: say what the judge takes, from one of "text", "images", "frames"/)
    assert.match(problems({ judges: { visual: { adapter: './judge.ts', accepts: ['video', 'text', 'text'] } } }), /accepts\[0\]: expected one of "text", "images", "frames", received "video"[\s\S]*accepts\[2\]: repeats "text"/)
  })

  test('refuses a check time or a limit that is not a whole number from 1, and an empty list of judges', () => {
    assert.match(problems({ judges: { visual: judge }, timeoutMs: 0 }), /evaluation\.timeoutMs: expected a whole number of milliseconds from 1/)
    assert.match(problems({ judges: { visual: judge }, limits: { concurrentCalls: 1.5 } }), /evaluation\.limits\.concurrentCalls: expected a whole number from 1/)
    assert.match(problems({ judges: {} }), /evaluation\.judges: expected at least one judge/)
    assert.match(problems({ defaultJudge: 'visual' }), /evaluation\.judges: missing required key/)
  })
})
