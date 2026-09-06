type LegacyCandidate = Readonly<{
  kind: string; direction: string; observedOutcome: string | null;
  adapter: string | null; providerIdempotencyKey: string | null;
  providerReference: string | null; durationSeconds: number | null;
  recordingStorageRef: string | null; transcriptStorageRef: string | null;
  callOutcome: string | null; metadata: unknown;
}>;

/** Only the former beginOutbound's exact authority-only payload, not manual evidence. */
export function isLegacyOutboundRequest(activity: LegacyCandidate): boolean {
  const metadata = activity.metadata;
  return ['call', 'text', 'email'].includes(activity.kind) && activity.direction === 'outbound'
    && activity.observedOutcome === null && activity.adapter === null
    && activity.providerIdempotencyKey === null && activity.providerReference === null
    && activity.durationSeconds === null && activity.recordingStorageRef === null
    && activity.transcriptStorageRef === null && activity.callOutcome === null
    && typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    && Object.keys(metadata).length === 2
    && Object.hasOwn(metadata, 'authorizationPolicyVersion') && Object.hasOwn(metadata, 'authorizationReason')
    && (metadata as Record<string, unknown>).authorizationPolicyVersion === 'outbound_compliance_v1'
    && (metadata as Record<string, unknown>).authorizationReason === 'allowed';
}

export function isOutboundCommandFact(activity: Readonly<{
  kind: string; direction: string; channel: string; adapter: string | null;
}>): boolean {
  return activity.kind === 'system' && activity.direction === 'internal'
    && activity.channel === 'outbound_command' && activity.adapter === 'callie_outbound_v1';
}

// Fixed predicates for single-Activity correlated subqueries only. No caller SQL.
// COALESCE prevents absent adapter/JSON values from hiding ordinary activities.
// Distinct keys and the last value match JSON.parse, including duplicate JSON keys.
export const outboundCommandFactSql = `(kind = 'system' AND direction = 'internal'
  AND channel = 'outbound_command' AND adapter = 'callie_outbound_v1')`;
export const communicationRecencySql = `NOT (COALESCE(${outboundCommandFactSql}, 0)
  OR COALESCE(CASE WHEN json_valid(metadata_json) THEN
    kind IN ('call', 'text', 'email') AND direction = 'outbound'
    AND observed_outcome IS NULL AND adapter IS NULL AND provider_idempotency_key IS NULL
    AND provider_reference IS NULL AND duration_seconds IS NULL
    AND recording_storage_ref IS NULL AND transcript_storage_ref IS NULL AND call_outcome IS NULL
    AND json_type(metadata_json) = 'object'
    AND (SELECT COUNT(DISTINCT key) FROM json_each(metadata_json)) = 2
    AND (SELECT value FROM json_each(metadata_json) WHERE key = 'authorizationPolicyVersion'
      ORDER BY id DESC LIMIT 1) = 'outbound_compliance_v1'
    AND (SELECT value FROM json_each(metadata_json) WHERE key = 'authorizationReason'
      ORDER BY id DESC LIMIT 1) = 'allowed'
  ELSE 0 END, 0))`;
