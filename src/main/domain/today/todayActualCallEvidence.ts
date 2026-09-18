import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../db/database';
import { accountInstantSchema } from '../../../shared/contracts/accountContract';
import { actualAccountCallOutcomes } from '../../../shared/contracts/accountOutboundContract';
import { campaignVersionSchema } from '../../../shared/contracts/campaignContract';
import { workerEventSchema, delegationCommandSchema } from '../../../shared/contracts/delegationContract';
import { accountFingerprint } from '../accounts/accountEvidence';

const actualOutcomes: ReadonlySet<string> = new Set(actualAccountCallOutcomes);
type Row = Record<string, string | number | null>;

/** Today-only historical evidence. No transaction, transport, IDs, or writes.
 * Scope comes from selected accounts and their persisted workspace authority,
 * not caller-supplied completion IDs. Later stop/opt-out facts do not erase calls.
 */
export function listDelegatedActualCallAccountIds(database: AppDatabase, input: {
  accountIds: readonly string[]; from: string; to: string; generatedAt: string;
}): string[] {
  const from = accountInstantSchema.parse(input.from);
  const to = accountInstantSchema.parse(input.to);
  const generatedAt = accountInstantSchema.parse(input.generatedAt);
  const completed = new Set<string>();
  const actions = new Set<string>();
  const query = database.raw.prepare(`
    SELECT h.*, o.event_id AS outcome_event_id, o.outcome_json, o.observed_at,
      e.event_json, e.fingerprint AS event_fingerprint,
      e.aggregate_version AS event_version, e.authority_generation AS event_generation,
      he.event_json AS handoff_event_json, he.fingerprint AS handoff_event_fingerprint,
      he.aggregate_version AS handoff_event_version, he.authority_generation AS handoff_event_generation, he.applied_at AS handoff_applied_at,
      c.command_id, c.command_json, c.fingerprint AS command_fingerprint,
      pc.command_id AS prepare_command_id, pc.command_json AS prepare_command_json, pc.fingerprint AS prepare_command_fingerprint,
      r.value AS route_value, r.channel AS route_channel,
      v.id AS campaign_version_id, v.campaign_id, v.version AS campaign_revision,
      v.snapshot_json, v.snapshot_hash,
      s.step_id, s.route_id AS evidence_route_id, s.route_version AS evidence_route_version,
      s.enrollment_id, s.context_revision AS evidence_context_revision, s.execution_context_id,
      s.outcome AS evidence_outcome, s.state AS evidence_state, s.source AS evidence_source,
      s.observation AS evidence_observation, s.observed_at AS evidence_observed_at,
      a.generation AS current_generation
    FROM delegated_manual_outcomes o
    JOIN delegated_authorities a ON a.account_id=o.account_id AND a.workspace_id=o.workspace_id
    JOIN delegated_applied_events e ON e.id=o.event_id AND e.workspace_id=o.workspace_id AND e.account_id=o.account_id AND e.stream='execution'
    JOIN delegated_commands c ON c.command_id=json_extract(e.event_json,'$.receipt.commandId') AND c.workspace_id=o.workspace_id AND c.account_id=o.account_id
    JOIN delegated_manual_handoffs h ON h.workspace_id=o.workspace_id AND h.account_id=o.account_id AND h.action_id=o.action_id AND h.handoff_id=json_extract(c.command_json,'$.payload.handoffId')
    JOIN delegated_applied_events he ON he.id=h.event_id AND he.workspace_id=h.workspace_id AND he.account_id=h.account_id AND he.stream='execution'
    JOIN delegated_commands pc ON pc.command_id=json_extract(he.event_json,'$.receipt.commandId') AND pc.workspace_id=h.workspace_id AND pc.account_id=h.account_id
    JOIN pm_account_routes r ON r.account_id=h.account_id AND r.id=h.route_id AND r.version=h.route_version
    JOIN campaign_step_receipts s ON s.workspace_id=o.workspace_id AND s.account_id=o.account_id AND s.command_id=c.command_id AND s.id=c.command_id AND s.action_id=o.action_id AND s.channel='call'
    JOIN campaign_versions v ON v.workspace_id=o.workspace_id AND v.id=json_extract(e.event_json,'$.campaign.evidence.campaignVersionId')
    WHERE o.account_id=? AND o.channel='call' AND h.channel='call' AND h.consumed_at IS NOT NULL
      AND o.observed_at>=? AND o.observed_at<? AND o.observed_at<=?
  `);
  for (const accountId of new Set(input.accountIds)) {
    const rows = query.all(accountId, from, to, generatedAt) as Row[];
    for (const row of rows) {
      // Corrupt/crossed persisted records are never evidence of completion.
      try {
        const event = workerEventSchema.parse(JSON.parse(String(row.event_json)));
        const handoffEvent = workerEventSchema.parse(JSON.parse(String(row.handoff_event_json)));
        const command = delegationCommandSchema.parse(JSON.parse(String(row.command_json)));
        const prepare = delegationCommandSchema.parse(JSON.parse(String(row.prepare_command_json)));
        const version = campaignVersionSchema.parse(JSON.parse(String(row.snapshot_json)));
        if (event.kind !== 'manual.outcome' || handoffEvent.kind !== 'manual.handoff'
          || command.kind !== 'complete-manual' || prepare.kind !== 'prepare-manual') continue;
        if (event.id !== row.outcome_event_id || handoffEvent.id !== row.event_id
          || event.aggregateVersion !== row.event_version || event.authorityGeneration !== row.event_generation
          || handoffEvent.aggregateVersion !== row.handoff_event_version || handoffEvent.authorityGeneration !== row.handoff_event_generation
          || accountFingerprint(event) !== row.event_fingerprint || accountFingerprint(handoffEvent) !== row.handoff_event_fingerprint
          || accountFingerprint(command) !== row.command_fingerprint || accountFingerprint(prepare) !== row.prepare_command_fingerprint) continue;
        if ([event, handoffEvent, command, prepare].some(value => value.workspaceId !== row.workspace_id || value.accountId !== accountId)
          || command.commandId !== row.command_id || prepare.commandId !== row.prepare_command_id
          || event.receipt.commandId !== command.commandId || handoffEvent.receipt.commandId !== prepare.commandId) continue;
        const handoff = handoffEvent.payload;
        const outcome = event.payload;
        const evidence = event.campaign?.evidence;
        const enrollment = event.campaign?.enrollment;
        if (outcome.channel !== 'call' || !actualOutcomes.has(outcome.outcome) || !evidence || !enrollment || evidence.conflict
          || event.campaign?.commandId !== command.commandId || evidence.channel !== 'call'
          || evidence.state !== 'human_reported_sent' || evidence.source !== 'human') continue;
        if (accountFingerprint(outcome) !== accountFingerprint(command.payload.outcome)
          || accountFingerprint(outcome) !== accountFingerprint(JSON.parse(String(row.outcome_json)))
          || outcome.actionId !== row.action_id || outcome.observedAt !== row.observed_at
          || outcome.observedAt < accountInstantSchema.parse(row.consumed_at)) continue;
        const { handoffId, expiresAt, ...binding } = handoff;
        if (accountFingerprint(binding) !== accountFingerprint(prepare.payload)
          || handoffId !== row.handoff_id || command.payload.handoffId !== handoffId
          || expiresAt !== row.expires_at || String(row.consumed_at) >= expiresAt
          || String(row.consumed_at) < accountInstantSchema.parse(row.handoff_applied_at)
          || handoff.actionId !== row.action_id || handoff.channel !== 'call'
          || handoff.routeId !== row.route_id || handoff.routeVersion !== row.route_version
          || handoff.targetHash !== row.target_hash || handoff.contentHash !== row.content_hash
          || handoff.contextRevision !== row.context_revision || command.payload.targetHash !== handoff.targetHash
          || row.route_channel !== 'phone' || createHash('sha256').update(String(row.route_value)).digest('hex') !== handoff.targetHash
          || event.authorityGeneration !== row.authority_generation || handoffEvent.authorityGeneration !== row.authority_generation
          || prepare.expectedAuthorityGeneration !== row.authority_generation || Number(row.current_generation) < event.authorityGeneration
          || command.expectedAuthorityGeneration < event.authorityGeneration || event.aggregateVersion <= handoffEvent.aggregateVersion) continue;
        // The outcome projects the latest enrollment, which may have changed route/context
        // before this late report. Validate its identity/version, not its current binding.
        // Historical action proof remains the exact original handoff and evidence receipt.
        if (version.id !== row.campaign_version_id || version.campaignId !== row.campaign_id || version.version !== row.campaign_revision
          || accountFingerprint(version) !== row.snapshot_hash || !version.cohortAccountIds.includes(accountId)
          || handoff.campaign.campaignId !== version.campaignId || handoff.campaign.campaignRevision !== version.version
          || !version.steps.some(step => step.id === evidence.stepId && step.channel === 'call')
          || evidence.campaignVersionId !== version.id || enrollment.campaignVersionId !== version.id
          || evidence.accountId !== accountId || enrollment.accountId !== accountId
          || evidence.enrollmentId !== handoff.campaign.enrollmentId || enrollment.id !== evidence.enrollmentId
          || enrollment.version <= handoff.campaign.enrollmentRevision
          || evidence.actionId !== handoff.actionId || evidence.stepId !== handoff.campaign.stepId
          || evidence.routeId !== handoff.routeId || evidence.routeVersion !== handoff.routeVersion
          || evidence.executionContextId !== handoff.contextRevision
          || evidence.outcome !== outcome.outcome || evidence.observedAt !== outcome.observedAt) continue;
        if (evidence.enrollmentId !== row.enrollment_id || evidence.stepId !== row.step_id
          || evidence.routeId !== row.evidence_route_id || evidence.routeVersion !== row.evidence_route_version
          || evidence.contextRevision !== row.evidence_context_revision || evidence.executionContextId !== row.execution_context_id
          || evidence.outcome !== row.evidence_outcome || evidence.state !== row.evidence_state
          || evidence.source !== row.evidence_source || evidence.observation !== row.evidence_observation
          || evidence.observedAt !== row.evidence_observed_at) continue;
        const action = JSON.stringify([row.workspace_id, accountId, handoff.actionId]);
        if (!actions.has(action)) { actions.add(action); completed.add(accountId); }
      } catch { /* Invalid local evidence cannot exclude a new nomination. */ }
    }
  }
  return [...completed];
}
