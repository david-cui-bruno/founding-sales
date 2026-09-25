/**
 * At-most-once sending: the fence, the ramp, the domain guard and the Sent-folder
 * reconciliation (specification 12.5 to 12.7, Appendix B).
 *
 * The public surface is deliberately small, and three of its functions are the whole
 * contract with G8's sequence lane:
 *
 *   * `prepareOutboundMessage` — create or reuse the one fence for a step execution,
 *     from bytes G8 has already rendered;
 *   * `dispatchOutboundMessage` — gate, count, claim, send, record. Called inside
 *     G8's `sequence.action` handler, which is why Appendix C gives that kind the
 *     protection `outbound_fence`;
 *   * `readOutboundOutcome` — what happened, in a closed vocabulary.
 *
 * Nothing here imports `@fss/domain/today` or anything of G8's. The reverse call —
 * telling a sequence that a fence reached a terminal state — is G8's adapter to
 * write, from `readOutboundOutcome`.
 */

export {
  DEFAULT_PERSONAL_GMAIL_GUARD,
  DOMAIN_GUARD_WINDOW_HOURS,
  OUTBOUND_STATES,
  PERSONAL_GMAIL_DOMAINS,
  PLACEMENT_RULE_VERSION,
  RAMP_ADMIN_RAISE_LIMIT,
  RAMP_HARD_CEILING,
  RAMP_SCHEDULE,
  RAMP_SETTLED_CAP,
  RECONCILE_BACKOFF_SECONDS,
  RECONCILE_WINDOW_HOURS,
  SEND_REFUSAL_CODES,
  TERMINAL_OUTBOUND_STATES,
  acceptSend,
  deterministicMessageId,
  fenceIdOfMessageId,
  fssFenceIdOfSentMessage,
  isPersonalGmailAddress,
  reconcileBackoffSeconds,
  refuseSend,
  type OutboundOutcomeState,
  type OutboundState,
  type SendRefusalCode,
  type SendResult,
} from './types.ts';

export {
  RAMP_MAX_BOUNCE_RATE,
  RAMP_MAX_OPT_OUT_RATE,
  RAMP_RATE_FLOOR,
  RAMP_SMALL_DAY_TOLERANCE,
  claimedAutomatedSends,
  closeSendDay,
  countAutomatedSend,
  countDirectSend,
  effectiveDailyCap,
  ensureRamp,
  listDaysToClose,
  openSendDay,
  rampHealthFailure,
  readRamp,
  readSendDayHealth,
  recordBounceAgainstDay,
  recordDaySignal,
  scheduledCap,
  setAdminCap,
  type AdminCapOutcome,
  type BounceAgainstDay,
  type CloseDayOutcome,
  type RampHealthFailure,
  type RampHealthSignals,
  type RampRow,
  type SendDayRow,
} from './ramp.ts';

export {
  authenticationPasses,
  decideDomainGuard,
  personalGmailRecipientsInWindow,
  readPrimarySendingDomain,
  normalizeSendingDomain,
  readSendingDomain,
  recordAuthenticationChecklist,
  registerMailboxSendingDomain,
  registerSendingDomain,
  setAutomatedSendingEnabled,
  setPersonalGmailGuard,
  type ChecklistOutcome,
  type DomainGuardDecision,
  type RegisterSendingDomainOutcome,
  type SendingDomainRefusal,
  type SendingDomainRegistrar,
  type SendingDomainRow,
} from './domainGuard.ts';

export {
  SENT_FOLDER_PRE_DISPATCH_PROVENANCE,
  SENT_TOMBSTONE_BODY,
  SENT_TOMBSTONE_FALLBACK_SUBJECT,
  SENT_TOMBSTONE_PROVENANCE,
  SENT_TOMBSTONE_RULE_VERSION,
  beginReconciling,
  claimForDispatch,
  fenceForOutgoingMessage,
  holdFence,
  insertSentTombstone,
  lockFenceForClaim,
  markUnknownTerminal,
  originatingSend,
  prepareOutboundMessage,
  readFence,
  readFenceByStepExecution,
  readFenceEvents,
  readFenceForSentMessage,
  readOutboundOutcome,
  recordReconcileMiss,
  recordReconciledSent,
  recordSent,
  markPreDispatchFenceSent,
  releaseFence,
  renderedHash,
  resolveUnknownTerminal,
  tombstoneSubject,
  type SentTombstoneInput,
  type DispatchClaim,
  type OutboundEmailRequest,
  type OutboundFenceRow,
  type OutboundOutcome,
  type OriginatingSend,
  type PreparedFence,
} from './fence.ts';

export { decideSend, holdReasonForRefusal, type SendGateDeps, type SendPlan } from './gate.ts';

export {
  decideStepPermission,
  dispatchHolidayCalendar,
  insideSendingWindow,
  sendRefusalForIneligibility,
  type StepPermission,
} from './stepPermission.ts';

export {
  dispatchOutboundMessage,
  type OutboundSendDeps,
  type SendOutcome,
  type SendReport,
} from './send.ts';

export {
  DEFAULT_ADOPT_AFTER_SECONDS,
  listFencesToReconcile,
  listMailboxesToReconcile,
  reconcileMailbox,
  reconcileOutboundMessage,
  type ReconcileDeps,
  type ReconcileOutcome,
  type ReconcileReport,
} from './reconcile.ts';

export { combinedRecoveryFloor, outboundRecoveryFloor } from './recoveryFloor.ts';

export {
  SENT_SCAN_HEADERS,
  SENT_SCAN_PAGE_LIMIT,
  SENT_SCAN_PAGE_SIZE,
  scanSentFolder,
  type SentFolderMessage,
  type SentFolderScan,
  type SentFolderScanDeps,
  type SentFolderScanOutcome,
} from './sentFolder.ts';

export {
  MAILBOX_DISCONNECTED_ALARM_HOURS,
  OUTBOUND_METRIC_NAMES,
  RECENT_SEND_WINDOW_DAYS,
  collectOutboundMetrics,
  mailboxDisconnectedHours,
  outboundDoubtCounts,
} from './metrics.ts';

export {
  RECONCILE_LEASE_SECONDS,
  mailReconcileHandler,
  type OutboundHandlerOptions,
} from './handlers.ts';
