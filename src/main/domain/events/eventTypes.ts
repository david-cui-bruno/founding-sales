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

export type Activity = {
  id: string;
  personId: string;
  prospectId: string | null;
  salesCycleId: string | null;
  cadenceStepId: string | null;
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
  metadata: unknown;
  createdAt: string;
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

export type AppendActivityInput = {
  id?: string;
  personId: string;
  prospectId?: string | null;
  salesCycleId?: string | null;
  cadenceStepId?: string | null;
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
  metadata?: unknown;
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
