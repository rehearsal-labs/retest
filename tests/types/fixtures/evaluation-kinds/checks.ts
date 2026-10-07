import { test, type EvaluateOptions, type EvaluationRequest } from '@rehearsal-labs/retest'

export const options: EvaluateOptions<'motion'> = {
  requirement: {
    end: { kind: 'state', requirement: 'The message says Saved.' },
    toast: { kind: 'seen', requirement: 'A saved notification appears.' },
    calm: { kind: 'never', requirement: 'No error banner appears.' },
  },
  evidence: { app: 'web', recording: { step: 'save' } },
}

test('typed recorded criteria', async () => {
  await test.evaluate(options)
  await test.evaluate({ requirement: { saved: { kind: 'state', requirement: 'Saved.' } }, evidence: { recording: { lastMs: 1000 } } })
  await test.evaluate({ requirement: { saved: { kind: 'sometimes', requirement: 'Saved.' } }, evidence: { recording: { step: 'save' } } }) // type-error TS2322 Type '"sometimes"' is not assignable to type 'CriterionKind | undefined'
  await test.evaluate({ requirement: { saved: { kind: 'seen' } }, evidence: { recording: { step: 'save' } } }) // type-error TS2322 Property 'requirement' is missing
  await test.evaluate({ requirement: { saved: { kind: 'seen', requirement: 'Saved.', absence: true } }, evidence: { recording: { step: 'save' } } }) // type-error TS2322 Type 'true' is not assignable to type 'undefined'
  await test.evaluate({ requirement: { saved: { kind: 'never', requirement: 3 } }, evidence: { recording: { step: 'save' } } }) // type-error TS2322 Type 'number' is not assignable to type 'string'
})

export function kindOf(request: EvaluationRequest): 'state' | 'seen' | 'never' | undefined { return request.criteria[0]?.kind }
