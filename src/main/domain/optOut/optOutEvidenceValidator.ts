import { z } from 'zod';

import { LifecycleEvidenceError } from '../support/domainErrors';
import {
  optOutUtcTimestampSchema,
  type OptOutTombstone,
} from './optOutTypes';

const identityPropagationMetadataSchema = z.object({
  sourceTombstoneId: z.string().trim().min(1),
}).strict();

export type OptOutEvidenceActivityFacts = Readonly<{
  id: string;
  personId: string;
  kind: string;
  direction: string;
  channel: string;
  occurredAt: string;
  observedOutcome: string | null;
  adapter: string | null;
  providerIdempotencyKey: string | null;
  providerReference: string | null;
  metadata: unknown;
}>;

export type OptOutEvidenceValidationInput = Readonly<{
  tombstone: OptOutTombstone;
  activity: OptOutEvidenceActivityFacts | null;
  sourceTombstone: OptOutTombstone | null;
}>;

export function optOutEvidenceViolations(
  input: OptOutEvidenceValidationInput,
): readonly string[] {
  const { tombstone, activity, sourceTombstone } = input;
  const violations: string[] = [];
  const requestedAt = parseTimestamp(tombstone.requestedAt);
  const createdAt = parseTimestamp(tombstone.createdAt);
  const occurredAt = parseTimestamp(activity?.occurredAt);

  if (requestedAt === null) violations.push('requested_at');
  if (createdAt === null) violations.push('created_at');
  if (requestedAt !== null && createdAt !== null && createdAt < requestedAt) {
    violations.push('created_before_request');
  }
  if (tombstone.policyVersion !== 'founder_opt_out_v1') violations.push('policy_version');
  if (activity === null
    || activity.id !== tombstone.sourceActivityId
    || activity.personId !== tombstone.personId
    || activity.observedOutcome !== 'opted_out') {
    violations.push('activity_ownership_or_outcome');
    return Object.freeze(violations);
  }
  if (occurredAt === null) violations.push('activity_occurred_at');

  if (tombstone.observedChannel === 'identity_propagation') {
    const metadata = identityPropagationMetadataSchema.safeParse(activity.metadata);
    const sourceId = metadata.success ? metadata.data.sourceTombstoneId : null;
    if (activity.kind !== 'system'
      || activity.direction !== 'internal'
      || activity.channel !== 'identity_propagation') {
      violations.push('identity_activity_shape');
    }
    if (sourceTombstone === null
      || sourceId !== sourceTombstone.id
      || sourceTombstone.id === tombstone.id
      || sourceTombstone.personId === tombstone.personId
      || tombstone.evidenceRef !== `tombstone:${sourceTombstone.id}`
      || tombstone.requestedAt !== sourceTombstone.requestedAt
      || tombstone.policyVersion !== sourceTombstone.policyVersion) {
      violations.push('identity_source_semantics');
    }
    if (requestedAt !== null && occurredAt !== null && occurredAt < requestedAt) {
      violations.push('identity_activity_before_source_request');
    }
    if (occurredAt !== null && createdAt !== null && occurredAt > createdAt) {
      violations.push('identity_activity_after_creation');
    }
    return Object.freeze(violations);
  }

  if (sourceTombstone !== null) violations.push('unexpected_source_tombstone');
  if (occurredAt !== null && requestedAt !== null && occurredAt > requestedAt) {
    violations.push('activity_after_request');
  }
  if (tombstone.evidenceRef !== expectedEvidenceRef(activity)) violations.push('evidence_ref');
  if (!channelEvidenceMatches(tombstone.observedChannel, activity)) {
    violations.push('channel_evidence');
  }
  return Object.freeze(violations);
}

export function assertCanonicalOptOutEvidence(input: OptOutEvidenceValidationInput): void {
  const violations = optOutEvidenceViolations(input);
  if (violations.length !== 0) {
    throw new LifecycleEvidenceError(`Opt-out tombstone evidence is invalid: ${violations.join(', ')}.`);
  }
}

export function expectedEvidenceRef(activity: OptOutEvidenceActivityFacts): string | null {
  if (activity.providerReference !== null) return activity.providerReference;
  if (activity.adapter !== null && activity.providerIdempotencyKey !== null) {
    return `${activity.adapter}:${activity.providerIdempotencyKey}`;
  }
  return null;
}

function channelEvidenceMatches(
  channel: OptOutTombstone['observedChannel'],
  activity: OptOutEvidenceActivityFacts,
): boolean {
  if (channel === 'imessage') {
    return activity.kind === 'text' && activity.direction === 'inbound'
      && activity.channel === 'imessage';
  }
  if (channel === 'gmail') {
    return activity.kind === 'email' && activity.direction === 'inbound'
      && activity.channel === 'gmail';
  }
  if (channel === 'manual') {
    return (activity.kind === 'note' || activity.kind === 'system')
      && activity.direction === 'internal' && activity.channel === 'manual';
  }
  if (channel === 'call') {
    return activity.kind === 'call'
      && (activity.direction === 'inbound' || activity.direction === 'outbound')
      && (activity.channel === 'phone' || activity.channel === 'call');
  }
  return false;
}

function parseTimestamp(value: unknown): number | null {
  const parsed = optOutUtcTimestampSchema.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : null;
}
