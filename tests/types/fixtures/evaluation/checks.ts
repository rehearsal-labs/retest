import type { DefaultJudgeName, JudgeAccepts, JudgeName } from '../../../../src/config/register.ts'
import type { Same } from '../support/same.ts'
import { chromium, defineConfig, test, type EvaluatorFactory } from '@rehearsal-labs/retest'

// The judges in retest.config.ts are registered: their names and what each accepts type-check every AI check.
export const judges: Same<JudgeName, 'visual' | 'words'> = true
export const defaultJudge: Same<DefaultJudgeName, 'visual'> = true
export const visualTakes: Same<JudgeAccepts<'visual'>, 'text' | 'images'> = true
export const wordsTakes: Same<JudgeAccepts<'words'>, 'text'> = true

test('judges a screen and a reply', async ({ page }) => {
  await page.goto('/')
  await test.evaluate({ requirement: 'The banner says the task was saved.', evidence: { capture: 'screenshot' } })
  await test.evaluate({ judge: 'visual', requirement: { saved: 'Saved.', titled: 'Titled.' }, evidence: [{ app: 'web', capture: 'screenshot' }, { text: 'Thanks!', label: 'reply' }], mode: 'advisory', timeoutMs: 5000 })
  await test.evaluate({ judge: 'words', requirement: 'The reply is polite.', evidence: { text: 'Thank you.' } })
})

test('mistakes', async () => {
  await test.evaluate({ judge: 'visul', requirement: 'x', evidence: { text: 'y' } }) // type-error TS2820 Type '"visul"' is not assignable to type '"visual" | "words" | undefined'. Did you mean '"visual"'?
  await test.evaluate({ judge: 'words', requirement: 'x', evidence: { capture: 'screenshot' } }) // type-error TS2353 'capture' does not exist in type 'TextEvidence |
  await test.evaluate({ requirement: 'x', evidence: { app: 'desktop', capture: 'screenshot' } }) // type-error TS2322 Type '"desktop"' is not assignable to type
  await test.evaluate({ requirement: 'x', evidence: { recording: { step: 'step-1' } } }) // type-error TS2353 'recording' does not exist in type
  await test.evaluate({ requirement: 'x', evidence: { text: 'y' }, mode: 'optional' }) // type-error TS2322 Type '"optional"' is not assignable to type 'EvaluationMode | undefined'
  await test.evaluate({ requirement: 'x', evidence: [] }) // type-error TS2322 Source has 0 element(s) but target requires 1
})

// A credential is never written into the config.
export const inline = defineConfig({
  apps: { web: chromium() },
  evaluation: { judges: { visual: { adapter: './visual.ts', credentials: { apiKey: 'sk-live-0123' }, accepts: ['images'] } } }, // type-error TS2322 Type 'string' is not assignable to type 'SecretSource'
})
export const noAccepts = defineConfig({
  apps: { web: chromium() },
  evaluation: { judges: { visual: { adapter: './visual.ts' } } }, // type-error TS2741 Property 'accepts' is missing
})
export const unknownKind = defineConfig({
  apps: { web: chromium() },
  evaluation: { judges: { visual: { adapter: './visual.ts', accepts: ['video'] } } }, // type-error TS2322 Type '"video"' is not assignable to type 'EvidenceKind'
})

// An adapter written in the project types its factory with the contract Retest exports.
export const factory: EvaluatorFactory = ({ credentials, options }) => ({
  identity: { provider: 'local', model: String(options['model']), version: 'local/1' },
  evaluate: async (request) => ({
    criteria: request.criteria.map(({ id }) => ({ id, verdict: credentials['apiKey'] === undefined ? 'inconclusive' : 'pass', citations: request.evidence.map((item) => item.id) })),
    justification: 'Checked.',
  }),
})

// Named evidence types are available to consumers from the package root.
import type { TextRecordsEvidence, DiagnosticsFor, EvidenceItem, AbsenceRequirement } from '@rehearsal-labs/retest'
export const selectedRecords: TextRecordsEvidence = { app: 'web', diagnostics: ['console', 'network'] }
export const textDiagnostics: DiagnosticsFor<'text'> = selectedRecords
export const visualEvidence: EvidenceItem<'visual'> = selectedRecords
export const forbiddenBanner: AbsenceRequirement = { requirement: 'No error banner appears.', absence: true }
export const imagesHaveNoDiagnostics: Same<DiagnosticsFor<'images'>, never> = true
export const wordsEvidence: EvidenceItem<'words'> = { diagnostics: 'console' }
