import type { LeadTriageSnapshot, LeadTriageSnapshotRequest } from '../../shared/contracts/leadTriageReportContract';
import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  AddLeadNoteRequest,
  CompleteActionRequest,
  LogCallOutcomeRequest,
  LogPastActivityRequest,
  MarkActivityInErrorRequest,
  PinActionRequest,
  SetReviewPositionRequest,
  SnoozeActionRequest,
  TodaySnapshot,
  TriageQueue,
} from '../../shared/contracts/todayContract';

/**
 * The renderer-facing Today surface. `get` returns one whole strict snapshot
 * and every command returns a MutationReceipt. This seam is distinct from the
 * domain TodayService: all ordering, capacity, opt-out checks, action
 * replacement, and lane assignment stay behind the domain facade.
 */
export type TodayProvider = {
  get(): Promise<TodaySnapshot>;
  complete(input: CompleteActionRequest): Promise<MutationReceipt>;
  snooze(input: SnoozeActionRequest): Promise<MutationReceipt>;
  pin(input: PinActionRequest): Promise<MutationReceipt>;
  logPastActivity(input: LogPastActivityRequest): Promise<MutationReceipt>;
  addLeadNote(input: AddLeadNoteRequest): Promise<MutationReceipt>;
  logCallOutcome(input: LogCallOutcomeRequest): Promise<MutationReceipt>;
  markActivityInError(input: MarkActivityInErrorRequest): Promise<MutationReceipt>;
  getLeadTriageSnapshot(input: LeadTriageSnapshotRequest): Promise<LeadTriageSnapshot>;
  getTriageQueue(): Promise<TriageQueue>;
  setReviewPosition(input: SetReviewPositionRequest): Promise<MutationReceipt>;
};

/** The domain facade methods the Today slice consumes. */
export type TodayDomainInvoker = {
  getToday(): TodaySnapshot | Promise<TodaySnapshot>;
  completePrimaryAction(input: CompleteActionRequest): MutationReceipt;
  snoozePrimaryAction(input: SnoozeActionRequest): MutationReceipt;
  pinWithinLane(input: PinActionRequest): MutationReceipt;
  logPastActivity(input: LogPastActivityRequest): MutationReceipt;
  addLeadNote(input: AddLeadNoteRequest): MutationReceipt;
  logCallOutcome(input: LogCallOutcomeRequest): MutationReceipt;
  markActivityInError(input: MarkActivityInErrorRequest): MutationReceipt;
  getLeadTriageSnapshot(input: LeadTriageSnapshotRequest): LeadTriageSnapshot | Promise<LeadTriageSnapshot>;
  getTriageQueue(): TriageQueue | Promise<TriageQueue>;
  setReviewPosition(input: SetReviewPositionRequest): MutationReceipt;
};
