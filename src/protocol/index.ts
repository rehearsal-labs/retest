export { ariaRoles } from './aria-role.ts'
export type { AriaRole } from './aria-role.ts'
export { commandResultSchema, describeCommand, observationSchema, observedItemLimit, pageCommandSchema } from './commands.ts'
export type { ActionKind, CommandResult, FillValue, Observation, ObservedItem, PageCommand } from './commands.ts'
export { defaultDiagnosticLimits, diagnosticLineSchema, diagnosticRecordSchema, diagnosticsSummarySchema } from './diagnostics.ts'
export type {
  CacheSource,
  CaptureFinishedLine,
  CaptureStartedLine,
  CaptureState,
  ConsoleCapture,
  ConsoleCounts,
  ConsoleLevel,
  ConsoleOrigin,
  ConsoleRecord,
  DiagnosticIdentity,
  DiagnosticKind,
  DiagnosticLimits,
  DiagnosticLine,
  DiagnosticRecord,
  DiagnosticScope,
  DiagnosticsPolicyRecord,
  DiagnosticsSummary,
  FrameRole,
  KindScope,
  NetworkCapture,
  NetworkCounts,
  NetworkFailedRecord,
  NetworkFinishedRecord,
  NetworkPendingRecord,
  NetworkRecord,
  NetworkRequestRecord,
  NetworkResponseRecord,
  PendingReason,
  RuntimeErrorRecord,
  ScopeArea,
  StackFrame,
} from './diagnostics.ts'
export type { DiagnosticIdentity as RecordIdentity } from './diagnostics.ts'
export { emulationSchema } from './emulation.ts'
export { evaluationRecordSchema } from './evaluation.ts'
export type {
  CriterionRecord,
  CriterionVerdict,
  EvaluationMode,
  EvaluationRecord,
  EvaluationSource,
  EvaluationVerdict,
  EvaluatorRecord,
  EvidenceKind,
  EvidenceRecord,
  HostEvaluationRecord,
} from './evaluation.ts'
export type { Emulation } from './emulation.ts'
export { retestEventSchema, targetInfoSchema } from './events.ts'
export type {
  CollectedTest,
  Counts,
  EventBody,
  EventOrigin,
  EventStamp,
  ExitCode,
  RetestEvent,
  RunStatus,
  TargetInfo,
  TestStatus,
} from './events.ts'
export { formatSessionId } from './evidence.ts'
export { cleanupRecordSchema, endingSchema, executionRecordSchema, preparationRecordSchema } from './execution.ts'
export type {
  AppSettings,
  BackendData,
  BundleRecord,
  CleanupRecord,
  ConfigurationRecord,
  Ending,
  EndingKind,
  EvaluationSettings,
  ExecutionRecord,
  ExecutionSettings,
  JudgeSettings,
  ModuleRecord,
  PreparationOutcome,
  PreparationRecord,
  RequirementCheck,
  RequirementRecord,
  RuntimeRecord,
  SecretDeclaration,
  SecretReference,
  SessionRecord,
  StartingState,
} from './execution.ts'
export type { EvidenceReference } from './evidence.ts'
export { captureSourceNameSchema } from './identity.ts'
export type { CaptureSourceName, RecordIdentity as SessionRecordIdentity } from './identity.ts'
export { failureSchema, sourceLocationSchema, truncatedTextSchema } from './failures.ts'
export type { Failure, FailureClass, FailureDetail, SourceLocation, TruncatedText } from './failures.ts'
export type { HostCheckActual, HostCheckRecord, HostCheckResult, HostCheckStatus } from './host-check.ts'
export { eventSchemaUrl, resultSchemaUrl } from './json-schemas.ts'
export { describeLocator, locatorRecipeSchema } from './locator.ts'
export type { LocatorRecipe } from './locator.ts'
export type { ObservedRecord } from './observation-record.ts'
export type { OptionChoiceRecord } from './option-choices.ts'
export type { NavigationCause, NavigationDocument, PageFacts } from './page-facts.ts'
export { evidenceGapCodes, evidenceStatusSchema, recordingRecordSchema, runEvidenceStatusSchema } from './recording.ts'
export type { EvidenceGap, EvidenceGapCode, EvidenceState, EvidenceStatus, MediaFrameCounts, RecordingClock, RecordingFrames, RecordingRecord, RecordingVideo, RunEvidenceStatus } from './recording.ts'
export { runResultSchema } from './result.ts'
export type { BrowserInfo, Evidence, FileResult, Narrowed, RunResult, TestResult } from './result.ts'
export { diagnosticsFolder, eventsFile, logsFolder, resultFile, testId, testTitle } from './run-folder.ts'
export { parse, toJsonSchema } from './schema.ts'
export type { Infer, Issue, JsonSchema, ParseResult, Schema } from './schema.ts'
export { secretPlaceholder } from './secret.ts'
export type { SecretRef } from './secret.ts'
export { storageStateSchema } from './storage-state.ts'
export type { StorageState, StoredCookie, StoredOrigin } from './storage-state.ts'
export { defaultTimeouts, mergeTimeouts, partialTimeoutsSchema, timeoutsSchema } from './timeouts.ts'
export type { Timeouts } from './timeouts.ts'
export { variantKey, variantSchema } from './variant.ts'
export type { Variant } from './variant.ts'
