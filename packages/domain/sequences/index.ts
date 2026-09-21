/**
 * Sequences, enrollments, step executions and the LinkedIn handoff
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
  STEP_COMPLETION_SOURCES,
  STEP_EXECUTION_STATES,
  STEP_RESULTS,
  acceptSequence,
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
  replaceDraftSteps,
  retireVersion,
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
  holdSource,
  mailboxSource,
  suppressionSource,
  templateApprovalSource,
  type StepEligibility,
  type StepEligibilityInput,
  type StepEligibilityOutcome,
  type StepEligibilitySource,
} from './eligibility.ts';

export {
  CLOCK_CLEARING_HOLDS,
  LINKEDIN_UNDO_WINDOW_MILLISECONDS,
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
  completeLinkedInStep,
  recordLinkedInResult,
  undoLinkedInStep,
  type LinkedInHandoff,
  type RecordLinkedInResultInput,
  type UndoLinkedInStepInput,
} from './linkedin.ts';

export {
  holdsAffectingEnrollment,
  resumeAfterReview,
  resumeEnrollment,
  type ResumeOutcome,
} from './resume.ts';

export {
  TERMINAL_STOP_EVENT_KINDS,
  TERMINAL_STOP_SUBSCRIBER,
  consumeSuppressionStops,
  consumeTerminalStops,
  listTerminalStopWork,
  type SuppressionStopReport,
  type TerminalStopReport,
  type TerminalStopWork,
} from './terminalStops.ts';

export { dueSequenceWorkSource } from './todaySource.ts';

export {
  applyEnrollmentMigration,
  approveEnrollmentMigration,
  proposeEnrollmentMigration,
  type MigrationItemOutcome,
  type MigrationReport,
  type ProposeMigrationInput,
} from './migration.ts';

export {
  TEMPLATE_VARIABLE_NAMES,
  firstNameOf,
  templateVariablesFor,
  type TemplateVariableName,
} from './variables.ts';

export { enrollmentFloor } from './recoveryFloor.ts';
