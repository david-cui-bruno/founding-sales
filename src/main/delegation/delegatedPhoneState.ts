import { z } from 'zod';
import type { AppDatabase } from '../db/database';
import { accountIdSchema, accountInstantSchema } from '../../shared/contracts/accountContract';
import { campaignVersionSchema, enrollmentSchema } from '../../shared/contracts/campaignContract';
import { authorityStateSchema, delegationCommandSchema, workerEventSchema, type WorkerEvent } from '../../shared/contracts/delegationContract';
import { commandReceiptSchema } from '../../shared/contracts/commandReceiptContract';
import { manualOutcomeSchema } from '../../shared/contracts/ownerCommandContract';
import { delegatedPhoneStateRequestSchema, delegatedPhoneStateSchema, PHONE_STATE_MAX_PREPARES, PHONE_STATE_MAX_COMPLETIONS, type GetPhoneHandoffStateRequest, type PhoneHandoffState } from '../../shared/contracts/delegatedPhoneStateContract';
import { accountFingerprint } from '../domain/accounts/accountEvidence';

const PHONE_STATE_MAX_SOURCE_ROWS_PER_TABLE = 512;
const PHONE_STATE_MAX_JSON_BYTES = 1_048_576;
const PHONE_STATE_MAX_SOURCE_BYTES = 8_388_608;
const PHONE_STATE_MAX_REPLY_BYTES = 8_388_608;
type Row = Record<string, unknown>;
const invalid = Symbol('invalid phone record');
function requireRecord(ok: unknown): asserts ok { if (!ok) throw invalid; }
const same = (a: unknown, b: unknown) => accountFingerprint(a) === accountFingerprint(b);
// These fixed projections guard corrupt scalar storage before SQLite returns it.
const text = (name: string, max = 200, nullable = false) => {
  const valid = `(typeof(${name})='text' AND length(${name}) BETWEEN 1 AND ${max} AND length(CAST(${name} AS BLOB))<=${max * 4})${nullable ? ` OR ${name} IS NULL` : ''}`;
  return { name, valid, sql: `CASE WHEN ${valid} THEN ${name} ELSE NULL END AS ${name}` };
};
const number = (name: string, minimum = 0) => {
  const valid = `typeof(${name})='integer' AND ${name} BETWEEN ${minimum} AND 9007199254740991`;
  return { name, valid, sql: `CASE WHEN ${valid} THEN ${name} ELSE NULL END AS ${name}` };
};
const hash = (name: string) => {
  const valid = `typeof(${name})='text' AND length(${name})=64 AND length(CAST(${name} AS BLOB))=64`;
  return { name, valid, sql: `CASE WHEN ${valid} THEN ${name} ELSE NULL END AS ${name}` };
};
const identity = [text('workspace_id'), text('account_id')];
const tables = [
  { name: 'delegated_commands', key: 'command_id', columns: [...identity, text('command_id'), hash('fingerprint'), text('created_at', 64)], json: ['command_json', 'receipt_json'] },
  { name: 'delegated_applied_events', key: 'id', columns: [...identity, text('id'), text('stream', 32), number('aggregate_version', 1), number('authority_generation'), hash('fingerprint'), text('applied_at', 64)], json: ['event_json'] },
  { name: 'delegated_manual_handoffs', key: 'handoff_id', columns: [...identity, text('handoff_id'), text('action_id'), number('authority_generation'), hash('target_hash'), hash('content_hash'), text('context_revision'), text('channel', 32), text('route_id'), number('route_version', 1), text('expires_at', 64), text('event_id'), text('consumed_at', 64, true), text('outcome_command_id', 200, true)], json: [] },
  { name: 'delegated_manual_outcomes', key: 'event_id', columns: [...identity, text('event_id'), text('action_id'), text('channel', 32), text('observed_at', 64)], json: ['outcome_json'] },
];
const headerSql = (columns: ReturnType<typeof text>[], json: string[] = []) => [
  ...columns.map(c => c.sql),
  `CASE WHEN ${[...columns.map(c => `(${c.valid})`), ...json.map(c => `typeof(${c})='text'`)].join(' AND ')} THEN 0 ELSE 1 END AS invalid`,
  ...json.map(c => `length(CAST(${c} AS BLOB)) AS ${c}_bytes`),
].join(',');
const receiptOf = (event: WorkerEvent) => 'receipt' in event ? event.receipt : event.kind === 'authority.changed' ? event.payload.receipt : event.kind === 'requested_followup.status' ? event.payload.status.receipt : null;

/** One bounded, synchronous, deferred snapshot. Historical facts confer no permission. */
export function readDelegatedPhoneHandoffState(database: AppDatabase, input: GetPhoneHandoffStateRequest & { workspaceId: string; generatedAt: string }): PhoneHandoffState {
  const request = delegatedPhoneStateRequestSchema.parse({ accountId: input.accountId, enrollmentId: input.enrollmentId, stepId: input.stepId });
  const workspaceId = accountIdSchema.parse(input.workspaceId), generatedAt = accountInstantSchema.parse(input.generatedAt), raw = database.raw;
  if (raw.inTransaction) throw Error('phone_snapshot_unavailable');
  return raw.transaction(() => {
    const owner = raw.prepare(`SELECT ${headerSql([...identity, text('owner', 32), text('state', 32), number('generation'), number('aggregate_version'), text('updated_at', 64)])} FROM delegated_authorities WHERE account_id=? LIMIT 2`).get(request.accountId) as Row | undefined;
    if (!owner || owner.invalid || owner.workspace_id !== workspaceId) throw Error('phone_scope_unavailable');
    authorityStateSchema.parse({ accountId: owner.account_id, owner: owner.owner, generation: owner.generation, state: owner.state });
    accountInstantSchema.parse(owner.updated_at);
    const enrollmentRow = raw.prepare(`SELECT ${headerSql([...identity, text('id'), text('campaign_version_id'), text('selected_route_id'), number('selected_route_version', 1), text('person_id', 200, true), text('current_step_id', 200, true), number('version', 1), text('state', 32), number('context_revision'), text('execution_context_id'), text('started_at', 64), text('updated_at', 64)])} FROM campaign_enrollments WHERE workspace_id=? AND id=? LIMIT 2`).get(workspaceId, request.enrollmentId) as Row | undefined;
    if (!enrollmentRow || enrollmentRow.invalid || enrollmentRow.account_id !== request.accountId) throw Error('phone_scope_unavailable');
    const enrollment = enrollmentSchema.parse({ id: enrollmentRow.id, accountId: enrollmentRow.account_id, campaignVersionId: enrollmentRow.campaign_version_id, selectedRouteId: enrollmentRow.selected_route_id, selectedRouteVersion: enrollmentRow.selected_route_version, personId: enrollmentRow.person_id, currentStepId: enrollmentRow.current_step_id, version: enrollmentRow.version, state: enrollmentRow.state, contextRevision: enrollmentRow.context_revision, executionContextId: enrollmentRow.execution_context_id, startedAt: enrollmentRow.started_at });
    accountInstantSchema.parse(enrollmentRow.updated_at);
    const versionRow = raw.prepare(`SELECT ${headerSql([text('workspace_id'), text('id'), text('campaign_id'), number('version', 1), hash('snapshot_hash'), text('created_at', 64)], ['snapshot_json'])} FROM campaign_versions WHERE workspace_id=? AND id=? LIMIT 2`).get(workspaceId, enrollment.campaignVersionId) as Row | undefined;
    if (!versionRow || versionRow.invalid || typeof versionRow.snapshot_json_bytes !== 'number' || versionRow.snapshot_json_bytes > PHONE_STATE_MAX_JSON_BYTES) throw Error('phone_scope_unavailable');
    const body = raw.prepare('SELECT snapshot_json FROM campaign_versions WHERE workspace_id=? AND id=? LIMIT 2').get(workspaceId, enrollment.campaignVersionId) as { snapshot_json: string };
    const version = campaignVersionSchema.parse(JSON.parse(body.snapshot_json));
    if (version.id !== versionRow.id || version.campaignId !== versionRow.campaign_id || version.version !== versionRow.version || accountFingerprint(version) !== versionRow.snapshot_hash || !version.cohortAccountIds.includes(request.accountId) || version.steps.filter(s => s.id === request.stepId && s.channel === 'call').length !== 1) throw Error('phone_scope_unavailable');
    accountInstantSchema.parse(versionRow.created_at);
    const scope = { ...request, workspaceId, generatedAt, remote: 'unknown' as const, campaign: { campaignId: version.campaignId, campaignRevision: version.version, campaignVersionId: version.id } };
    const incomplete = (issue: Extract<PhoneHandoffState, { completeness: 'incomplete' }>['issue']): PhoneHandoffState => delegatedPhoneStateSchema.parse({ ...scope, completeness: 'incomplete', issue, attempts: [], completions: [] });
    let bytes = versionRow.snapshot_json_bytes;
    const headers: Row[][] = [];
    for (const table of tables) {
      const rows = raw.prepare(`SELECT ${headerSql(table.columns, table.json)} FROM ${table.name} WHERE workspace_id=? AND account_id=? ORDER BY ${table.key} COLLATE BINARY LIMIT ${PHONE_STATE_MAX_SOURCE_ROWS_PER_TABLE + 1}`).all(workspaceId, request.accountId) as Row[];
      if (rows.length > PHONE_STATE_MAX_SOURCE_ROWS_PER_TABLE) return incomplete('source_limit');
      for (const row of rows) for (const column of table.json) {
        const size = row[`${column}_bytes`];
        if (typeof size === 'number') { if (size > PHONE_STATE_MAX_JSON_BYTES) return incomplete('source_limit'); bytes += size; }
      }
      headers.push(rows);
    }
    if (bytes > PHONE_STATE_MAX_SOURCE_BYTES) return incomplete('source_limit');
    if (headers.some(rows => rows.some(row => row.invalid))) return incomplete('invalid_record');
    // Bodies are fetched only after all admission checks, in the same snapshot.
    const bodies = tables.map(table => table.json.length ? raw.prepare(`SELECT ${table.key},${table.json.join(',')} FROM ${table.name} WHERE workspace_id=? AND account_id=? ORDER BY ${table.key} COLLATE BINARY LIMIT ${PHONE_STATE_MAX_SOURCE_ROWS_PER_TABLE + 1}`).all(workspaceId, request.accountId) as Row[] : []);
    try {
      const parseJson = (value: unknown): unknown => { requireRecord(typeof value === 'string'); return JSON.parse(value); };
      const time = (value: unknown) => { const at = accountInstantSchema.parse(value); requireRecord(at <= generatedAt); return at; };
      const commands = headers[0].map((row, i) => {
        const command = delegationCommandSchema.parse(parseJson(bodies[0][i].command_json)), receipt = commandReceiptSchema.parse(parseJson(bodies[0][i].receipt_json));
        requireRecord(command.commandId === row.command_id && command.accountId === request.accountId && command.workspaceId === workspaceId && accountFingerprint(command) === row.fingerprint && receipt.commandId === command.commandId && receipt.status !== 'applied' && (receipt.status !== 'pending' || receipt.authorityGeneration === command.expectedAuthorityGeneration && receipt.aggregateVersion === command.expectedVersion));
        return { command, receipt, queuedAt: time(row.created_at) };
      });
      const events = headers[1].map((row, i) => {
        const event = workerEventSchema.parse(parseJson(bodies[1][i].event_json));
        requireRecord(event.id === row.id && event.workspaceId === workspaceId && event.accountId === request.accountId && event.aggregateVersion === row.aggregate_version && event.authorityGeneration === row.authority_generation && accountFingerprint(event) === row.fingerprint && row.stream === (event.kind.startsWith('research.') ? 'research' : 'execution'));
        return { event, appliedAt: time(row.applied_at) };
      });
      const outcomes = headers[3].map((row, i) => {
        const outcome = manualOutcomeSchema.parse(parseJson(bodies[3][i].outcome_json));
        requireRecord(outcome.actionId === row.action_id && outcome.channel === row.channel && outcome.observedAt === row.observed_at); time(row.observed_at);
        return { row, outcome };
      });
      for (const h of headers[2]) {
        accountIdSchema.parse(h.handoff_id); accountIdSchema.parse(h.action_id); accountIdSchema.parse(h.event_id);
        requireRecord(h.channel === 'call' || h.channel === 'linkedin'); accountInstantSchema.parse(h.expires_at);
        if (h.consumed_at !== null) time(h.consumed_at);
        requireRecord(/^[a-f0-9]{64}$/.test(String(h.target_hash)) && /^[a-f0-9]{64}$/.test(String(h.content_hash)));
      }
      const selected: typeof commands = [];
      for (const c of commands) if (c.command.kind === 'prepare-manual' && c.command.payload.channel === 'call' && c.command.payload.campaign.enrollmentId === request.enrollmentId && c.command.payload.campaign.stepId === request.stepId) { selected.push(c); if (selected.length > PHONE_STATE_MAX_PREPARES) break; }
      if (selected.length > PHONE_STATE_MAX_PREPARES) return incomplete('prepare_limit');
      const selectedActions = new Set(selected.map(c => c.command.kind === 'prepare-manual' ? c.command.payload.actionId : ''));
      const selectedHandoffs = new Set(headers[2].filter(h => selectedActions.has(String(h.action_id))).map(h => h.handoff_id));
      const completions: typeof commands = [];
      for (const c of commands) if (c.command.kind === 'complete-manual' && (selectedActions.has(c.command.payload.outcome.actionId) || selectedHandoffs.has(c.command.payload.handoffId))) { completions.push(c); if (completions.length > PHONE_STATE_MAX_COMPLETIONS) break; }
      if (completions.length > PHONE_STATE_MAX_COMPLETIONS) return incomplete('completion_limit');
      let ambiguous = false;
      // Fixed-reference checks return guarded identities only, never foreign JSON bodies.
      for (const c of [...selected, ...completions]) {
        const refs = raw.prepare(`SELECT ${headerSql([...identity, text('id')])} FROM delegated_applied_events
          WHERE CASE WHEN json_valid(event_json) THEN json_extract(event_json,'$.receipt.commandId')=? OR json_extract(event_json,'$.payload.receipt.commandId')=? OR (json_extract(event_json,'$.kind')='requested_followup.status' AND (json_extract(event_json,'$.payload.commandId')=? OR json_extract(event_json,'$.payload.status.receipt.commandId')=?)) END
          ORDER BY id COLLATE BINARY LIMIT 2`).all(c.command.commandId, c.command.commandId, c.command.commandId, c.command.commandId) as Row[];
        requireRecord(refs.every(r => !r.invalid && r.workspace_id === workspaceId && r.account_id === request.accountId));
        if (refs.length > 1) ambiguous = true;
      }
      for (const action of selectedActions) {
        const refs = raw.prepare(`SELECT ${headerSql([...identity, text('handoff_id')])} FROM delegated_manual_handoffs WHERE workspace_id=? AND action_id=? ORDER BY handoff_id COLLATE BINARY LIMIT 2`).all(workspaceId, action) as Row[];
        requireRecord(refs.every(r => !r.invalid && r.account_id === request.accountId));
        if (refs.length > 1) ambiguous = true;
        if (commands.filter(c => c.command.kind === 'prepare-manual' && c.command.payload.actionId === action).length > 1) ambiguous = true;
        const prepareRefs = raw.prepare(`SELECT ${headerSql([...identity, text('command_id')])} FROM delegated_commands
          WHERE workspace_id=? AND CASE WHEN json_valid(command_json) THEN json_extract(command_json,'$.kind')='prepare-manual' AND json_extract(command_json,'$.payload.actionId')=? END
          ORDER BY command_id COLLATE BINARY LIMIT 2`).all(workspaceId, action) as Row[];
        requireRecord(prepareRefs.every(r => !r.invalid && r.account_id === request.accountId));
        if (prepareRefs.length > 1) ambiguous = true;
        const crossedEvents = raw.prepare(`SELECT ${headerSql([...identity, text('id')])} FROM delegated_applied_events
          WHERE workspace_id=? AND account_id<>? AND CASE WHEN json_valid(event_json) THEN json_extract(event_json,'$.kind') IN ('manual.handoff','manual.outcome') AND json_extract(event_json,'$.payload.actionId')=? END
          ORDER BY id COLLATE BINARY LIMIT 2`).all(workspaceId, request.accountId, action) as Row[];
        requireRecord(crossedEvents.length === 0);
      }
      const commandMap = new Map(commands.map(c => [c.command.commandId, c]));
      const eventMap = new Map(events.map(e => [e.event.id, e]));
      // Validate both projection directions, including unclassifiable orphan calls.
      for (const h of headers[2]) {
        const e = eventMap.get(String(h.event_id));
        requireRecord(e?.event.kind === 'manual.handoff');
        const p = e.event.payload;
        requireRecord(p.handoffId === h.handoff_id && p.actionId === h.action_id && p.channel === h.channel && p.routeId === h.route_id && p.routeVersion === h.route_version && p.targetHash === h.target_hash && p.contentHash === h.content_hash && p.contextRevision === h.context_revision && p.expiresAt === h.expires_at && e.event.authorityGeneration === h.authority_generation);
        if (h.consumed_at !== null) requireRecord(e.appliedAt <= String(h.consumed_at) && String(h.consumed_at) < p.expiresAt);
      }
      for (const o of outcomes) {
        const e = eventMap.get(String(o.row.event_id));
        requireRecord(e?.event.kind === 'manual.outcome' && same(e.event.payload, o.outcome));
      }
      for (const { event, appliedAt } of events) {
        if (event.kind !== 'manual.handoff' && event.kind !== 'manual.outcome') continue;
        const c = commandMap.get(event.receipt.commandId);
        requireRecord(c && c.receipt.status === 'pending' && c.queuedAt <= appliedAt);
        if (event.kind === 'manual.handoff') {
          requireRecord(c.command.kind === 'prepare-manual');
          requireRecord(same(event.payload, { ...c.command.payload, handoffId: event.payload.handoffId, expiresAt: event.payload.expiresAt }) && event.authorityGeneration === c.command.expectedAuthorityGeneration && event.aggregateVersion === c.command.expectedVersion + 1);
          requireRecord(headers[2].some(h => h.event_id === event.id));
        } else {
          requireRecord(c.command.kind === 'complete-manual' || c.command.kind === 'manual-outcome');
          requireRecord(same(event.payload, c.command.kind === 'complete-manual' ? c.command.payload.outcome : c.command.payload));
          requireRecord(outcomes.some(o => o.row.event_id === event.id));
        }
      }
      // Every complete-manual record must resolve using both original identities.
      for (const c of commands) if (c.command.kind === 'complete-manual') {
        const p = c.command.payload;
        const hs = headers[2].filter(h => h.handoff_id === p.handoffId || h.action_id === p.outcome.actionId);
        requireRecord(hs.length > 0 && hs.every(h => h.handoff_id === p.handoffId && h.action_id === p.outcome.actionId && h.channel === p.outcome.channel && h.target_hash === p.targetHash && h.consumed_at !== null && String(h.consumed_at) <= p.outcome.observedAt));
        time(p.outcome.observedAt);
      }
      for (const c of commands) if (c.command.kind === 'manual-outcome' && selectedActions.has(c.command.payload.actionId)) throw invalid;
      const effective = (c: typeof commands[number]) => {
        const acks = events.filter(e => receiptOf(e.event)?.commandId === c.command.commandId);
        if (acks.length > 1) ambiguous = true;
        for (const ack of acks) {
          const r = receiptOf(ack.event)!;
          requireRecord(c.receipt.status === 'pending' && ack.appliedAt >= c.queuedAt && (r.status === 'rejected' ? ack.event.kind === 'authority.changed' : r.status === 'applied' && ack.event.kind === (c.command.kind === 'prepare-manual' ? 'manual.handoff' : 'manual.outcome')));
        }
        const ack = acks[0];
        return { receipt: ack ? receiptOf(ack.event)! : c.receipt, receiptEvent: ack ? { eventId: ack.event.id, kind: ack.event.kind, authorityGeneration: ack.event.authorityGeneration, aggregateVersion: ack.event.aggregateVersion, appliedAt: ack.appliedAt } : null, ack };
      };
      const attempts = selected.map(c => {
        requireRecord(c.command.kind === 'prepare-manual');
        const command = c.command, effectiveReceipt = effective(c), hs = headers[2].filter(h => h.action_id === command.payload.actionId);
        const owners = commands.filter(p => p.command.kind === 'prepare-manual' && p.command.payload.actionId === command.payload.actionId);
        if (owners.length > 1 || hs.length > 1) ambiguous = true;
        const ack = effectiveReceipt.ack, h = hs.find(h => h.event_id === ack?.event.id);
        if (ack?.event.kind === 'manual.handoff' && ack.event.campaign) requireRecord(!ack.event.campaign.cap || ack.event.campaign.cap.campaignVersionId === version.id);
        requireRecord(h ? ack?.event.kind === 'manual.handoff' : hs.length === 0 || owners.length > 1);
        return { command: c.command, queuedAt: c.queuedAt, receipt: effectiveReceipt.receipt, receiptEvent: effectiveReceipt.receiptEvent,
          handoff: ack?.event.kind === 'manual.handoff' && h ? { value: ack.event.payload, authorityGeneration: ack.event.authorityGeneration, consumedAt: h.consumed_at } : null };
      });
      const completed = completions.map(c => {
        requireRecord(c.command.kind === 'complete-manual');
        const command = c.command, parents = attempts.filter(a => a.command.payload.actionId === command.payload.outcome.actionId && a.handoff?.value.handoffId === command.payload.handoffId);
        requireRecord(parents.length > 0); if (parents.length > 1) ambiguous = true;
        const parent = parents[0], effectiveReceipt = effective(c), event = effectiveReceipt.ack?.event;
        let applied = null;
        if (event?.kind === 'manual.outcome') {
          const campaign = event.campaign;
          requireRecord(campaign?.evidence && campaign.enrollment && parent.handoff);
          requireRecord(campaign.commandId === command.commandId && campaign.enrollment.id === request.enrollmentId && campaign.enrollment.accountId === request.accountId && campaign.enrollment.campaignVersionId === version.id && campaign.enrollment.version > parent.command.payload.campaign.enrollmentRevision);
          requireRecord(!campaign.cap || campaign.cap.campaignVersionId === version.id);
          requireRecord(!campaign.version || campaign.version.id === version.id && campaign.version.campaignId === version.campaignId && campaign.version.version === version.version);
          applied = { outcome: event.payload, campaignCommandId: campaign.commandId, evidence: campaign.evidence };
        }
        return { prepareCommandId: parent.command.commandId, command, queuedAt: c.queuedAt, receipt: effectiveReceipt.receipt, receiptEvent: effectiveReceipt.receiptEvent, applied };
      });
      for (const h of headers[2].filter(h => selectedActions.has(String(h.action_id)))) if (h.outcome_command_id !== null) requireRecord(completed.some(c => c.command.commandId === h.outcome_command_id && c.command.payload.handoffId === h.handoff_id));
      const order = (a: { queuedAt: string; command: { commandId: string } }, b: { queuedAt: string; command: { commandId: string } }) => a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : a.command.commandId < b.command.commandId ? -1 : a.command.commandId > b.command.commandId ? 1 : 0;
      const result = { ...scope, completeness: 'complete' as const, issue: null as null, attempts: attempts.sort(order), completions: completed.sort(order) };
      // Validate all independent fields before an ambiguity hold.
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > PHONE_STATE_MAX_REPLY_BYTES) return incomplete('source_limit');
      const checked = delegatedPhoneStateSchema.safeParse(result);
      if (!checked.success && checked.error.issues.some(issue => issue.message !== 'Phone history ambiguous identity')) return incomplete('invalid_record');
      if (ambiguous || !checked.success) return incomplete('ambiguous_identity');
      return checked.data;
    } catch (error) {
      if (error === invalid || error instanceof z.ZodError || error instanceof SyntaxError) return incomplete('invalid_record');
      throw error;
    }
  }).deferred();
}
