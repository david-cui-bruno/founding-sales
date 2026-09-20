/**
 * Reply classification: the model layer, the reply card, and the confirmation
 * (specification 8.3, 12.4).
 *
 * The deterministic layer lives in `packages/domain/src/rules/replyClassification.ts`
 * and its effects in `packages/domain/mail/effects.ts`; both ran when the message
 * arrived. This package is everything that happens *after* that, and its whole shape
 * is one sentence of 12.4: the model may label and prioritise, and a person decides.
 *
 * See `docs/greenfield/classification.md`.
 */

export {
  CLASSIFICATION_REFUSAL_CODES,
  CLASSIFIER_CALL_OUTCOMES,
  CLASSIFIER_EFFORTS,
  CLASSIFIER_MODELS,
  CLASSIFIER_PROMPT_VERSION,
  DEFAULT_CLASSIFIER_SETTINGS,
  MODEL_CAPABILITIES,
  SERVER_SIDE_FALLBACK_BETA,
  UNSENT_CALL_OUTCOMES,
  acceptClassification,
  isClassifierEffort,
  isClassifierModel,
  refuseClassification,
  type CallbackProposal,
  type ClassificationRefusalCode,
  type ClassificationResult,
  type ClassifierCallOutcome,
  type ClassifierCallRecord,
  type ClassifierEffort,
  type ClassifierModel,
  type ClassifierSettings,
  type ModelCapabilities,
  type ModelSuggestion,
} from './types.ts';

export {
  MODEL_SUGGESTION_JSON_SCHEMA,
  MODEL_SUGGESTION_SCHEMA_JSON,
  excerptIsVerbatim,
  readModelSuggestion,
  type SuggestionRead,
  type SuggestionReadFailure,
} from './schema.ts';

export {
  CLASSIFIER_SYSTEM_PROMPT,
  buildClassifierRequest,
  classifierUserText,
  type BuildRequestInput,
  type ClassifierInput,
  type ClassifierRequest,
} from './prompt.ts';

export {
  CLASSIFIER_SECRET_ENVIRONMENT_VARIABLES,
  CLASSIFIER_SECRET_NAMES,
  ClassifierSecretError,
  describeClassifierSecrets,
  environmentClassifierSecrets,
  loadAnthropicTransport,
  staticClassifierSecrets,
  type AnthropicMessageResponse,
  type AnthropicMessagesTransport,
  type AnthropicTextBlock,
  type AnthropicUsage,
  type ClassifierSecretName,
  type ClassifierSecretProvider,
} from './anthropicClient.ts';

export {
  anthropicReplyClassifier,
  cacheReadTokens,
  type AnthropicClassifierOptions,
  type ClassifierAttempt,
  type ReplyClassifierPort,
} from './adapter.ts';

export {
  cacheablePrefix,
  corpusRequestKey,
  recordedAnthropicTransport,
  type RecordedAnswer,
  type RecordedAnthropicTransport,
  type RecordedCall,
  type RecordedTransportOptions,
} from './recorded.ts';

export {
  readClassifierSettings,
  updateClassifierSettings,
  type UpdateClassifierSettingsInput,
} from './settings.ts';

export {
  countCallsToday,
  listClassifications,
  listPendingModelClassifications,
  readClassification,
  recordClassifierCall,
  proposedDispositionOf,
  recordModelClassification,
  type ClassificationRow,
  type PendingClassification,
  type ProposedDisposition,
  type RecordModelClassificationInput,
} from './store.ts';

export {
  classifyReplyWithModel,
  type ClassifyReplyDeps,
  type ClassifyReplyOutcome,
  type SkipReason,
} from './classify.ts';

export {
  REPLY_NEXT_ACTIONS,
  listReplyCards,
  readReplyCard,
  type ReplyCardCandidateDto,
  type ReplyCardDto,
  type ReplyCardHoldDto,
  type ReplyCardSignalDto,
  type ReplyNextAction,
} from './cards.ts';

export {
  confirmReplyDisposition,
  readConfirmation,
  type ConfirmReplyDispositionInput,
  type ConfirmReplyDispositionOutcome,
  type ConfirmedCallback,
  type ReplyConfirmationRow,
} from './confirmations.ts';

export {
  CLASSIFY_LEASE_SECONDS,
  classifyReplyHandler,
  type ClassifyHandlerOptions,
} from './handler.ts';
