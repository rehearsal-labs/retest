import type { EvaluationRequest, EvaluatorSetup } from '../../src/evaluation/contract.ts'
import type { FakeEvaluator } from '../support/fake-evaluator.ts'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import createFakeEvaluator from '../support/fake-evaluator.ts'

export type DeliveredImages = {
 requestId:string
 images:{id:string;app:string;bytes:number;sha256:string;capturedAt:string}[]
}

// Observe the actual approved byte arrays at the adapter boundary; keep the original request and answer.
export default function evidenceJudge(setup:EvaluatorSetup):FakeEvaluator {
 const hashLog=setup.options['hashLog']
 if(typeof hashLog!=='string')throw new TypeError('The evidence judge requires its explicit hashLog path.')
 const judge=createFakeEvaluator(setup)
 return {
  identity:judge.identity,
  evaluate:(request:EvaluationRequest)=>{
   const delivered:DeliveredImages={requestId:request.requestId,images:request.evidence.flatMap(item=>item.kind==='image'?[{id:item.id,app:item.app,bytes:item.data.byteLength,sha256:createHash('sha256').update(item.data).digest('hex'),capturedAt:item.capturedAt}]:[])}
   appendFileSync(hashLog,JSON.stringify(delivered)+'\n')
   return judge.evaluate(request)
  },
 }
}
