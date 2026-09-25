/**
 * Gmail synchronization, matching and deterministic classification effects
 * (specification 12.1 to 12.4, 12.6).
 *
 * Four seams and one pipeline. The Gmail API, the envelope key, the Pub/Sub push
 * token and the OAuth client secret each sit behind an interface with a fake that
 * needs no credential; everything else is ordinary repository code against
 * `RepositoryContext`. See `docs/greenfield/mail.md`.
 *
 * G7-2 adds `packages/domain/outbound` beside this: the at-most-once fence, sending,
 * the reputation ramp and the domain guard. It extends three things here and nothing
 * else — `GmailClient` gains `sendMessage` and the Sent-folder search, `matching.ts`'s
 * Message-ID rule gains the fence as a second source, and `recover.ts`'s
 * `RecoveryFloorSource` gains its real implementation.
 */

export {
  GMAIL_SCOPES,
  METADATA_HEADERS,
  MAIL_EFFECT_KINDS,
  MAIL_REFUSAL_CODES,
  DEFAULT_BASELINE_DAYS,
  DETERMINISTIC_RULES_VERSION,
  RECOVERY_OVERLAP_SECONDS,
  RECOVERY_PAGE_SIZE,
  WATCH_EXPIRY_ALARM_HOURS,
  WATCH_RENEWAL_INTERVAL_HOURS,
  acceptMail,
  normalizeAddress,
  normalizeAddressList,
  normalizeMessageId,
  normalizeMessageIdList,
  refuseMail,
  type MailDirection,
  type MailEffectKind,
  type MailMatchRule,
  type MailMessageRow,
  type MailRefusalCode,
  type MailResult,
  type MailboxRow,
  type MailboxStatus,
  type MailboxSyncState,
} from './types.ts';

export {
  GmailClientError,
  directionOfLabels,
  headerValue,
  type GmailAccessGrant,
  type GmailAttachmentReference,
  type GmailAuthorizationGrant,
  type GmailClient,
  type GmailHistoryOutcome,
  type GmailHistoryRecord,
  type GmailHistoryRequest,
  type GmailListOutcome,
  type GmailListRequest,
  type GmailMessageBody,
  type GmailMessageMetadata,
  type GmailOAuthConfig,
  type GmailProfile,
  type GmailSendOutcome,
  type GmailSendRequest,
  type GmailSentSearchOutcome,
  type GmailTokenOutcome,
  type GmailWatchOutcome,
  type GmailWatchRegistration,
} from './gmailClient.ts';

export {
  fixtureDirection,
  recordedGmailClient,
  type GmailFakeCall,
  type GmailFixture,
  type GmailFixtureMessage,
  type RecordedGmailClient,
} from './gmailClientFake.ts';

export {
  DEFAULT_MAX_BODY_CHARACTERS,
  classifyStatus,
  createGmailHttpClient,
  httpFetch,
  mimeOf,
  readAttachmentReferences,
  readBodyText,
  type GmailFailure,
  type GmailHttpOptions,
  type HttpFetch,
  type HttpRequest,
  type HttpResponse,
} from './gmailClientHttp.ts';

export {
  ENVELOPE_ALGORITHM,
  EnvelopeError,
  envelopeCipher,
  localDataKeyWrapper,
  localEnvelopeCipher,
  type DataKeyWrapper,
  type EnvelopeCipher,
  type EnvelopeCiphertext,
  type WrappedDataKey,
} from './envelope.ts';

export {
  kmsDataKeyWrapper,
  loadKmsTransport,
  type KmsDecryptInput,
  type KmsDecryptOutput,
  type KmsGenerateDataKeyInput,
  type KmsGenerateDataKeyOutput,
  type KmsTransport,
  type KmsWrapperOptions,
} from './envelopeKms.ts';

export {
  MAIL_SECRET_NAMES,
  SECRET_ENVIRONMENT_VARIABLES,
  SecretProviderError,
  describeSecretProvider,
  environmentSecretProvider,
  staticSecretProvider,
  type MailSecretName,
  type SecretProvider,
} from './secretProvider.ts';

export {
  DEFAULT_PUSH_TOKEN_POLICY,
  PUSH_TOKEN_REFUSALS,
  decidePushToken,
  fixturePushTokens,
  publicKeyPushTokenVerifier,
  readGmailNotification,
  readPushTokenClaims,
  type FixturePushTokens,
  type GmailNotification,
  type PubSubPushBody,
  type PushTokenClaims,
  type PushTokenDecision,
  type PushTokenPolicy,
  type PushTokenRefusal,
  type PushTokenVerifier,
} from './pushToken.ts';

export {
  GMAIL_API_BASE_URL,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  describeMailConfig,
  pushTokenPolicyOf,
  resolveGmailOAuthConfig,
  type MailPublicConfig,
} from './config.ts';

export {
  MAILBOX_CHECK_INTERVAL_SECONDS,
  MAILBOX_HOLD_BLOCKS,
  advanceCursor,
  advanceGeneration,
  insertOrReviveMailbox,
  listConnectedMailboxes,
  listMailboxesDueForSync,
  mailboxAutomationBlocked,
  markMailboxDisconnected,
  openMailboxHold,
  readMailbox,
  readMailboxForOwner,
  readMailboxForUpdate,
  readMailboxHold,
  recordMailboxHeartbeat,
  recordSyncError,
  releaseMailboxHold,
  setSyncState,
  type CursorOutcome,
  type InsertMailboxInput,
  type MailboxDueRow,
} from './mailboxes.ts';

export {
  deleteRefreshToken,
  hasRefreshToken,
  readRefreshToken,
  storeRefreshToken,
} from './tokens.ts';

export {
  DEFAULT_GRANT_SECONDS,
  beginGmailGrant,
  completeGmailGrant,
  disconnectMailbox,
  grantCodeChallenge,
  grantCodeVerifier,
  readOwnMailbox,
  signGrantState,
  verifyGrantState,
  type BeginGrantOutcome,
  type CompleteGrantOutcome,
  type DisconnectOutcome,
  type GrantStateClaims,
  type MailGrantDeps,
} from './oauth.ts';

export {
  WEBHOOK_REFUSALS,
  receivePushNotification,
  type WebhookDeps,
  type WebhookOutcome,
  type WebhookRefusal,
  type WebhookRequest,
} from './webhook.ts';

export {
  coalesceMailSync,
  payloadHistoryId,
  payloadMailboxId,
  type CoalesceMailSyncInput,
  type CoalesceOutcome,
  type CoalesceResult,
} from './coalesce.ts';

export {
  discardMessageBody,
  listMessagesForOpportunity,
  markMessageMatched,
  normalizeMetadata,
  readMessage,
  readMessageBody,
  recordMessage,
  storeMessageBody,
  type NormalizedMetadata,
  type RecordedMessage,
} from './messages.ts';

export {
  findMatchCandidates,
  listMatches,
  recordMatches,
  resolveAmbiguity,
  type AmbiguityResolution,
  type MatchCandidate,
  type RecordedMatch,
  type RecordedMatches,
} from './matching.ts';

export {
  applyClassificationEffects,
  applyDirectSendEffects,
  classifyReply,
  recordDeterministicClassification,
  type AppliedEffect,
  type ClassificationEffects,
  type ClassificationEffectsInput,
  type DirectSendOutcome,
  type ReplyClassification,
} from './effects.ts';

export {
  pendingReplyPromoter,
  recordingReplyPromoter,
  replyItemKey,
  type PendingReplyPromoter,
  type ReplyPromoter,
  type ReplyPromotion,
} from './replyLane.ts';

export {
  EMPTY_PIPELINE_REPORT,
  processMessageIds,
  type MessagePipelineDeps,
  type MessagePipelineReport,
} from './pipeline.ts';

export {
  DEFAULT_SYNC_MESSAGE_LIMIT,
  DEFAULT_SYNC_PAGE_LIMIT,
  accessForMailbox,
  holdForRevokedGrant,
  runMailSync,
  type MailSyncDeps,
  type MailSyncOutcome,
  type MailSyncReport,
} from './sync.ts';

export {
  NO_RECOVERY_FLOOR,
  listIncompleteRecoveries,
  readRecovery,
  rearmRecoveryJob,
  runMailRecovery,
  startRecovery,
  type MailRecoveryDeps,
  type MailRecoveryOutcome,
  type MailRecoveryReport,
  type RecoveryFloorSource,
  type RecoveryRow,
  type StartRecoveryInput,
} from './recover.ts';

export {
  cancelWatch,
  hoursToSoonestWatchExpiry,
  listWatchesDue,
  nextWatchGeneration,
  readCurrentWatch,
  renewWatch,
  type WatchDueRow,
  type WatchRenewalDeps,
  type WatchRenewalOutcome,
  type WatchRenewalReport,
  type WatchRow,
} from './watch.ts';

export {
  MAIL_LEASE_SECONDS,
  mailRecoveryHandler,
  mailSyncHandler,
  watchRenewalHandler,
  type MailHandlerOptions,
} from './handlers.ts';

export { MAIL_METRIC_NAMES, collectMailMetrics, mailboxDisconnectedHours } from './metrics.ts';
