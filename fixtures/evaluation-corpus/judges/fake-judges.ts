import type { EvaluationRequest, EvaluatorSetup, JudgeAnswer } from '../../../src/evaluation/contract.ts'
import type { CriterionVerdict } from '../../../src/protocol/evaluation.ts'
// Four fake judges that prove the corpus runner's arithmetic without a model. They know nothing about images or text:
// `perfect` answers a fixed script declared here, independent of the labels scored; `always-pass` passes everything;
// `flip` follows the script on the first and third repeat and answers the
// opposite on the second, so repeats disagree; `error` fails every call. None of them says anything about how well a
// model judges. Each reads the case and repeat from the request id the corpus sends, `corpus-r<repeat>:<case>`.

// Fixed offline answers. Changing a corpus label does not change these answers. This tests arithmetic, not image interpretation.
const scriptedVerdicts: Readonly<Record<string, CriterionVerdict>> = {
  "shot-chrome-saved": "pass",
  "shot-firefox-saved": "pass",
  "shot-webkit-saved": "pass",
  "shot-chrome-saved-wrong": "fail",
  "shot-webkit-saved-wrong": "fail",
  "shot-webkit-save-failed": "fail",
  "shot-chrome-saving": "fail",
  "shot-firefox-clipped-end": "inconclusive",
  "shot-firefox-clipped-whole": "fail",
  "shot-chrome-injection": "fail",
  "shot-webkit-injection": "fail",
  "shot-chrome-covered": "inconclusive",
  "shot-chrome-short-viewport": "inconclusive",
  "shot-taskphone-open": "pass",
  "shot-taskphone-done": "fail",
  "shot-taskphone-id": "fail",
  "shot-taskphone-covered-list": "inconclusive",
  "shot-taskphone-signed-in": "fail",
  "shot-taskdesk-form": "pass",
  "shot-taskdesk-signed-in": "fail",
  "text-saved": "pass",
  "text-saved-wrong": "fail",
  "text-save-failed": "fail",
  "text-saving": "fail",
  "text-clipped-full": "pass",
  "text-clipped-cut": "inconclusive",
  "text-injection": "fail",
  "text-saved-firefox": "pass",
  "text-saved-wrong-webkit": "fail",
  "text-quiet-network": "pass",
  "text-diagnostics-page-errors": "fail",
  "text-diagnostics-cut": "inconclusive",
  "text-quiet-console": "pass",
  "text-covered-page": "pass",
  "frames-toast": "pass",
  "frames-toast-wrong": "inconclusive",
  "frames-toast-omitted": "inconclusive",
  "frames-toast-dropped": "inconclusive",
  "frames-toast-bound": "inconclusive",
  "frames-flash-shown": "pass",
  "frames-flash-absence": "fail",
  "frames-flash-omitted": "inconclusive",
  "frames-injection": "inconclusive",
  "frames-spinner": "pass",
  "frames-spinner-early": "inconclusive"
}

type Behaviour = 'perfect' | 'always-pass' | 'flip' | 'error'

const behaviours: readonly Behaviour[] = ['perfect', 'always-pass', 'flip', 'error']

/**
 * Makes one fake corpus judge. `options.behaviour` picks it; The answers are fixed here and never read from the labels being scored.
 *
 * @example export default fakeCorpusJudge
 */
export default function fakeCorpusJudge(setup: EvaluatorSetup): { identity: { provider: string; model: string; version: string }; evaluate: (request: EvaluationRequest) => Promise<JudgeAnswer> } {
  const behaviour = behaviours.find((each) => each === setup.options['behaviour'])
  if (behaviour === undefined) throw new Error(`The fake corpus judge needs options.behaviour, one of ${behaviours.join(', ')}.`)
  return {
    identity: { provider: 'fake', model: `corpus-${behaviour}`, version: 'fake-corpus-judge/2' },
    async evaluate(request) {
      if (behaviour === 'error') throw new Error('The fake corpus judge fails every call, as a provider that is down would.')
      const { caseId, repeat } = parseRequestId(request.requestId)
      const scripted = scriptedVerdicts[caseId]
      if (scripted === undefined) throw new Error(`The fake corpus judge has no scripted answer for ${caseId}.`)
      const verdict = verdictFor(behaviour, scripted, repeat)
      const cited = caseId === 'frames-flash-absence' ? 'e1-f2' : request.evidence[0]?.id ?? request.frames?.[0]?.frames.at(-1)?.id
      if (cited === undefined) throw new Error('The request holds no evidence to cite.')
      return {
        criteria: request.criteria.map(({ id, kind }) => {
          const witness = caseId === 'frames-toast' ? 'e1-f3' : caseId === 'frames-flash-shown' ? 'e1-f2' : caseId === 'frames-spinner' && id === 'saving' ? 'e1-f2' : cited
          return { id, verdict, citations: verdict === 'inconclusive' ? [] : [kind === 'state' ? cited : witness] }
        }),
        justification: `The fake ${behaviour} judge answered ${verdict}.`,
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      }
    },
  }
}

function verdictFor(behaviour: Exclude<Behaviour, 'error'>, scripted: CriterionVerdict, repeat: number): CriterionVerdict {
  if (behaviour === 'always-pass') return 'pass'
  if (behaviour === 'perfect' || repeat !== 2) return scripted
  return scripted === 'pass' ? 'fail' : 'pass'
}

function parseRequestId(requestId: string): { caseId: string; repeat: number } {
  const matched = /^corpus-r(\d+):(.+)$/.exec(requestId)
  if (matched === null) throw new Error(`The fake corpus judge cannot read the request id ${requestId}.`)
  return { repeat: Number(matched[1]), caseId: matched[2] ?? '' }
}
