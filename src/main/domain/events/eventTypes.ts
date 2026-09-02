import type { LifecycleStage } from '../../db/domainSchema';

export type ActivityKind =
  | 'call'
  | 'voicemail'
  | 'text'
  | 'email'
  | 'interview'
  | 'offer'
  | 'note'
  | 'job'
  | 'system';

type ActivityCadenceEvidence =
  | {
    salesCycleId: string | null;
    cadenceEnrollmentId: null;
    cadenceStepId: null;
    cadenceComponentId: null;
  }
  | {
    salesCycleId: string;
    cadenceEnrollmentId: string;
    cadenceStepId: string;
    cadenceComponentId: string;
  };

export type CallOutcomeKind =
  | 'no_answer'
  | 'voicemail'
  | 'spoke'
  | 'interview_booked'
  | 'not_interested'
  | 'opted_out';

export type Activity = ActivityCadenceEvidence & {
  id: string;
  personId: string;
  prospectId: string | null;
  kind: ActivityKind;
  direction: 'inbound' | 'outbound' | 'internal';
  channel: string;
  occurredAt: string;
  durationSeconds: number | null;
  observedOutcome: string | null;
  adapter: string | null;
  providerIdempotencyKey: string | null;
  providerReference: string | null;
  consentPolicyRecordId: string | null;
  recordingStorageRef: string | null;
  transcriptStorageRef: string | null;
  metadata: unknown;
  createdAt: string;
  /** Founder-authored prose; the ONE place prose is allowed. Local-only. */
  noteText: string | null;
  callOutcome: CallOutcomeKind | null;
  callbackAt: string | null;
};

export type ActivityAmendment = {
  id: string;
  activityId: string;
  amendmentKind: string;
  correction: unknown;
  reason: string;
  createdAt: string;
};

export type StageEvent = {
  id: string;
  salesCycleId: string;
  fromStage: LifecycleStage | null;
  toStage: LifecycleStage;
  effectiveAt: string;
  confirmedAt: string;
  confirmationKind: 'mechanical' | 'founder' | 'backfill';
  transitionSequence: number;
  backfillProvenance: unknown | null;
  createdAt: string;
};

export type ConsentPolicyRecord = {
  id: string;
  personId: string;
  activityId: string | null;
  policyKind: 'recording' | 'cloud_processing' | 'outbound';
  policyVersion: string;
  effectiveAt: string;
  decision: 'granted' | 'denied' | 'not_required' | 'unknown';
  evidence: unknown;
  createdAt: string;
};

type AppendActivityCadenceEvidence =
  | {
    salesCycleId?: string | null;
    cadenceEnrollmentId?: null;
    cadenceStepId?: null;
    cadenceComponentId?: null;
  }
  | {
    salesCycleId: string;
    cadenceEnrollmentId: string;
    cadenceStepId: string;
    cadenceComponentId: string;
  };

export type AppendActivityInput = AppendActivityCadenceEvidence & {
  id?: string;
  personId: string;
  prospectId?: string | null;
  kind: ActivityKind;
  direction: 'inbound' | 'outbound' | 'internal';
  channel: string;
  occurredAt?: string;
  durationSeconds?: number | null;
  observedOutcome?: string | null;
  adapter?: string | null;
  providerIdempotencyKey?: string | null;
  providerReference?: string | null;
  consentPolicyRecordId?: string | null;
  recordingStorageRef?: string | null;
  transcriptStorageRef?: string | null;
  metadata?: unknown;
  noteText?: string | null;
  callOutcome?: CallOutcomeKind | null;
  callbackAt?: string | null;
};

export type AppendActivityAmendmentInput = {
  id?: string;
  activityId: string;
  amendmentKind: string;
  correction: unknown;
  reason: string;
};

export type AppendStageEventInput = {
  id?: string;
  salesCycleId: string;
  fromStage: LifecycleStage | null;
  toStage: LifecycleStage;
  effectiveAt: string;
  confirmedAt?: string;
  confirmationKind: 'mechanical' | 'founder' | 'backfill';
  transitionSequence: number;
  backfillProvenance?: unknown | null;
};

export type AppendConsentPolicyRecordInput = {
  id?: string;
  personId: string;
  activityId?: string | null;
  policyKind: 'recording' | 'cloud_processing' | 'outbound';
  policyVersion: string;
  effectiveAt: string;
  decision: 'granted' | 'denied' | 'not_required' | 'unknown';
  evidence: unknown;
};
