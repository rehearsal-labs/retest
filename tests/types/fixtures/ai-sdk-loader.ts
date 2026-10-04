import type { EvaluatorSetup } from '@rehearsal-labs/retest'
import type { AiSdkPackageLoader, AiSdkPackageName } from '@rehearsal-labs/retest/evaluation/ai-sdk'
import type { Same } from './support/same.ts'
import { createAiSdkEvaluatorWith } from '@rehearsal-labs/retest/evaluation/ai-sdk'

// A host that bundles the SDK hands the adapter a loader typed to the packages it may ask for.
declare const setup: EvaluatorSetup
declare const bundled: { readonly ai: object; readonly '@ai-sdk/anthropic': object; readonly '@ai-sdk/openai': object; readonly '@ai-sdk/azure': object }

export const names: Same<AiSdkPackageName, 'ai' | '@ai-sdk/anthropic' | '@ai-sdk/openai' | '@ai-sdk/azure'> = true

const narrow = async (name: 'ai' | '@ai-sdk/anthropic' | '@ai-sdk/openai' | '@ai-sdk/azure'): Promise<object> => bundled[name]
export const fromNarrow = createAiSdkEvaluatorWith(setup, narrow)
export const fromRecord = createAiSdkEvaluatorWith(setup, async (name) => bundled[name])
export const typed: AiSdkPackageLoader = narrow

// A loader that cannot load every package the adapter may ask for is refused.
const partial = async (name: 'ai' | '@ai-sdk/azure'): Promise<object> => bundled[name]
export const fromPartial = createAiSdkEvaluatorWith(setup, partial) // type-error TS2345 is not assignable to parameter of type 'AiSdkPackageLoader'
