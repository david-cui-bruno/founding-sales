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
  metadataValid?: boolean;
}>;

export type OptOutEvidenceValidationInput = Readonly<{
  tombstone: OptOutTombstone;
  activity: OptOutEvidenceActivityFacts | null;
  sourceTombstone: OptOutTombstone | null;
}>;

export type OptOutEvidenceNode = Readonly<{
  tombstone: OptOutTombstone;
  activity: OptOutEvidenceActivityFacts | null;
}>;

export const OPT_OUT_PROVENANCE_MAX_DEPTH = 64;

export function optOutEvidenceViolations(
  input: OptOutEvidenceValidationInput,
): readonly string[] {
  const { tombstone, activity, sourceTombstone } = input;
  const violations: string[] = [];
  const requestedAt = parseTimestamp(tombstone.requestedAt);
  const createdAt = parseTimestamp(tombstone.createdAt);
  const occurredAt = parseTimestamp(activity?.occurredAt);

  if (activity?.metadataValid === false) violations.push('activity_metadata_json');

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

export function optOutProvenanceViolations(input: Readonly<{
  root: OptOutEvidenceNode;
  loadSource: (tombstoneId: string) => OptOutEvidenceNode | null;
  maxDepth?: number;
}>): readonly string[] {
  const violations: string[] = [];
  const maxDepth = input.maxDepth ?? OPT_OUT_PROVENANCE_MAX_DEPTH;
  const visit = (node: OptOutEvidenceNode, depth: number, path: ReadonlySet<string>): void => {
    if (path.has(node.tombstone.id)) {
      violations.push('provenance_cycle');
      return;
    }
    if (depth >= maxDepth) {
      violations.push('provenance_depth');
      return;
    }
    const sourceId = sourceTombstoneId(node.tombstone);
    const source = sourceId === null ? null : input.loadSource(sourceId);
    violations.push(...optOutEvidenceViolations({
      tombstone: node.tombstone,
      activity: node.activity,
      sourceTombstone: source?.tombstone ?? null,
    }));
    if (node.tombstone.observedChannel === 'identity_propagation' && source !== null) {
      visit(source, depth + 1, new Set([...path, node.tombstone.id]));
    }
  };
  visit(input.root, 0, new Set());
  return Object.freeze([...new Set(violations)]);
}

export function assertCanonicalOptOutProvenance(input: Readonly<{
  root: OptOutEvidenceNode;
  loadSource: (tombstoneId: string) => OptOutEvidenceNode | null;
}>): void {
  const violations = optOutProvenanceViolations(input);
  if (violations.length !== 0) {
    throw new LifecycleEvidenceError(`Opt-out provenance is invalid: ${violations.join(', ')}.`);
  }
}

export function parseOptOutActivityMetadataJson(value: unknown): Readonly<
  | { success: true; metadata: unknown }
  | { success: false; metadata: null }
> {
  if (typeof value !== 'string') return Object.freeze({ success: false, metadata: null });
  try {
    return Object.freeze({ success: true, metadata: JSON.parse(value) as unknown });
  } catch {
    return Object.freeze({ success: false, metadata: null });
  }
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

export function optOutCallEvidenceMatches(activity: OptOutEvidenceActivityFacts): boolean {
  return activity.kind === 'call'
    && (activity.direction === 'inbound' || activity.direction === 'outbound')
    && (activity.channel === 'phone' || activity.channel === 'call');
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
    return optOutCallEvidenceMatches(activity);
  }
  return false;
}

function parseTimestamp(value: unknown): number | null {
  const parsed = optOutUtcTimestampSchema.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : null;
}

function sourceTombstoneId(tombstone: OptOutTombstone): string | null {
  return tombstone.observedChannel === 'identity_propagation'
    && tombstone.evidenceRef?.startsWith('tombstone:')
    ? tombstone.evidenceRef.slice('tombstone:'.length) : null;
}
