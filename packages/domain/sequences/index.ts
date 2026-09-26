/**
 * Sequences, enrollments and step executions
 * (specification 11 in full, 4.3, 8.2, Appendix A, B, C, D and G).
 *
 * The pure rules are G0's, in `packages/domain/src/rules/` — the cadence walk, the
 * business-day calendar, the email window, the hold union and the template hash. This
 * package is the database and the transactions around them. See
 * `docs/greenfield/sequences.md`.
 */

export {
  ENROLLMENT_END_REASONS,
  ENROLLMENT_STATES,
  SEQUENCE_REFUSAL_CODES,
  SEQUENCE_STOP_CONDITIONS,
  SEQUENCE_VERSION_STATES,
  STEP_CHANNELS,
  STEP_COMPLETION_SOURCES,
  STEP_EXECUTION_STATES,
  STEP_RESULTS,
  acceptSequence,
  isStepChannel,
  refuseSequence,
  type EnrollmentEndReason,
  type EnrollmentRow,
  type EnrollmentState,
  type SequenceDelay,
  type SequenceRefusalCode,
  type SequenceResult,
  type SequenceRow,
  type SequenceStepRow,
  type SequenceStopCondition,
  type SequenceVersionRow,
  type SequenceVersionState,
  type StepChannel,
  type StepCompletionSource,
  type StepExecutionRow,
  type StepExecutionState,
  type StepResult,
} from './types.ts';

export {
  listEnrollments,
  listSequenceVersions,
  listStepExecutions,
  loadEnrollmentForUpdate,
  loadStepExecutionForUpdate,
  lockStepWithEnrollment,
  nextUnfinishedExecution,
  readEnrollment,
  readSequenceSteps,
  readSequenceVersion,
  readStepExecution,
  unexecutedExecutions,
  type ListEnrollmentsInput,
} from './rows.ts';

export {
  createDraftVersion,
  createSequence,
  listSequences,
  publishVersion,
  retireVersion,
  saveSteps,
  type CreateDraftVersionInput,
  type CreateSequenceInput,
  type DraftStepInput,
  type ReplaceDraftStepsInput,
} from './definitions.ts';

export {
  currentHolidayCalendar,
  holidayCalendarByVersion,
  recordHolidayCalendar,
  type RecordHolidayCalendarInput,
} from './calendars.ts';

export {
  calendarOfEnrollment,
  completeEnrollment,
  enrollContact,
  stepForCadence,
  stopEnrollments,
  type EnrollContactInput,
  type EnrolledOutcome,
  type StopEnrollmentsInput,
  type StopReport,
} from './enrollments.ts';

export {
  CHANNEL_ACTION_KINDS,
  allowAllEligibility,
  assignmentSource,
  composeEligibility,
  controlModeSource,
  defaultEligibilitySources,
  emailRouteSource,
  enrollmentSource,
  holdSource,
  mailboxSource,
  suppressionSource,
  templateApprovalSource,
  type FrozenEnvelope,
  type StepEligibility,
  type StepEligibilityInput,
  type StepEligibilityOutcome,
  type StepEligibilitySource,
} from './eligibility.ts';

export {
  CLOCK_CLEARING_HOLDS,
  DEFAULT_HOLD_RECHECK_MILLISECONDS,
  HOLD_RECHECK_MILLISECONDS,
  holdRecheckMilliseconds,
  completeEmailStep,
  completeStepExecution,
  dispatchPreparedStep,
  rescheduleExecution,
  runDueStepExecution,
  type CompleteStepInput,
  type CompletedStep,
  type DispatchStepOutcome,
  type RescheduleInput,
  type RunDueStepInput,
  type StepRunOutcome,
} from './executions.ts';

export {
  OUTBOUND_FENCE_STATES,
  SEND_HANDOFF_REFUSALS,
  recordingSendHandoff,
  unavailableSendHandoff,
  type DispatchSendOutcome,
  type OutboundEmailRequest,
  type OutboundFenceOutcome,
  type OutboundFenceState,
  type PrepareSendOutcome,
  type RecordingSendHandoff,
  type SendHandoff,
  type SendHandoffRefusal,
} from './sendHandoff.ts';

export {
  holdsAffectingEnrollment,
  previewResume,
  resumeEnrollment,
  type ResumeOutcome,
  type ResumePreview,
  type ResumePreviewHold,
  type ResumePreviewStep,
} from './resume.ts';

export {
  TERMINAL_STOP_EVENT_KINDS,
  TERMINAL_STOP_SUBSCRIBER,
  applyManualModeStop,
  consumeSuppressionStops,
  consumeTerminalStops,
  manualModeEndReason,
  readTerminalStopWork,
  type SuppressionStopReport,
  type TerminalStopReport,
  type TerminalStopWork,
} from './terminalStops.ts';

export { dueSequenceWorkSource } from './todaySource.ts';

export {
  BLOCKING_HOLD_SQL,
  DISPATCH_RECOVERY_GRACE_SECONDS,
  STEP_WAKE_LIMIT,
  listStepWakes,
  type StepWake,
} from './wake.ts';

export { COMPLETION_ANCHOR_RULE_SUFFIX, successorDue, type SuccessorDue, type SuccessorDueInput } from './successor.ts';

export {
  TEMPLATE_VARIABLE_NAMES,
  firstNameOf,
  templateVariablesFor,
  type TemplateVariableName,
} from './variables.ts';

export { enrollmentFloor } from './recoveryFloor.ts';

export {
  EXPECTED_HOLD_REASONS,
  SEQUENCE_METRIC_NAMES,
  collectSequenceMetrics,
  countEnrollments,
  type EnrollmentCounts,
} from './metrics.ts';
