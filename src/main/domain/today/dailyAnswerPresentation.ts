import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../db/database';
import { accountInstantSchema, accountLinkSchema, accountRouteSchema, accountSourceSchema, type AccountRoute } from '../../../shared/contracts/accountContract';
import { dailyAnswerPresentationMatches, displayContactSchema, displayRoleSchema, requestedAnswerPresentationSchema, manualAnswerPresentationSchema, type DisplayContact, type DisplayIssue, type RequestedAnswerPresentation } from '../../../shared/contracts/dailyAnswerPresentationContract';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
import type { RequestedFollowupDraft } from '../../../shared/contracts/requestedFollowupContract';
import { workerEventSchema } from '../../../shared/contracts/delegationContract';
import { validateRequestedOriginalCall } from '../../outreach/requestedFollowupService';

type Row = Record<string, unknown>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Query-only decoration inside the caller's existing snapshot. No owner/preflight reads. */
class PresentationReader {
  readonly issues: DisplayIssue[] = [];
  constructor(readonly database: AppDatabase, readonly workspaceId: string, readonly asOf: string) {}
  private one(sql: string, ...args: (string | number)[]): Row | undefined { return this.database.raw.prepare(sql).get(...args) as Row | undefined; }
  private rows(sql: string, ...args: (string | number)[]): Row[] { return this.database.raw.prepare(sql).all(...args) as Row[]; }
  private issue(field: DisplayIssue['field'], reason: DisplayIssue['reason']) {
    if (!this.issues.some(i => i.field === field && i.reason === reason)) this.issues.push({ field, reason });
  }
  private sources(accountId: string, ids: string[]) {
    if (!ids.length || ids.length > 100) throw Error('missing_evidence');
    for (const id of ids) {
      const row = this.one('SELECT * FROM pm_account_sources WHERE account_id=? AND id=?', accountId, id);
      if (!row || accountInstantSchema.parse(row.admitted_at) > this.asOf) throw Error('unavailable_evidence');
      const source = accountSourceSchema.parse({ id: row.id, url: row.url, fetchedAt: row.fetched_at, sha256: row.sha256, excerpt: row.excerpt, permitted: row.permitted === 1 });
      if (!source.permitted || source.fetchedAt > this.asOf) throw Error('invalid_evidence');
    }
  }
  private route(accountId: string, id: string, version: number): AccountRoute {
    const r = this.one('SELECT * FROM pm_account_routes WHERE account_id=? AND id=? AND version=?', accountId, id, version);
    if (!r || accountInstantSchema.parse(r.admitted_at) > this.asOf) throw Error('route_missing');
    const evidenceIds = this.rows('SELECT source_id FROM pm_account_route_evidence WHERE account_id=? AND route_id=? AND route_version=? ORDER BY source_id LIMIT 101', accountId, id, version).map(e => String(e.source_id));
    const route = accountRouteSchema.parse({ id: r.id, accountId, personId: r.person_id, version: r.version, channel: r.channel, value: r.value, purpose: r.purpose, verification: r.verification, evidenceIds });
    this.sources(accountId, route.evidenceIds);
    return route;
  }
  private role(accountId: string, personId: string): DisplayContact['role'] {
    try {
      // Inspect dates before filtering so corrupt potentially applicable rows cannot hide a conflict.
      const rows = this.rows("SELECT * FROM pm_account_links WHERE account_id=? AND person_id=? AND kind='person_role' ORDER BY id LIMIT 101", accountId, personId);
      if (rows.length > 100) throw Error('role_limit');
      const applicable: NonNullable<DisplayContact['role']>[] = [];
      for (const r of rows) {
        const admitted = accountInstantSchema.parse(r.admitted_at), from = accountInstantSchema.parse(r.valid_from), to = r.valid_to === null ? null : accountInstantSchema.parse(r.valid_to);
        if (admitted > this.asOf || from > this.asOf || to !== null && to <= this.asOf) continue;
        const evidence = this.rows('SELECT source_id,purpose FROM pm_account_link_evidence WHERE account_id=? AND link_id=? ORDER BY source_id LIMIT 201', accountId, String(r.id));
        const link = accountLinkSchema.parse({ id: r.id, kind: 'person_role', personId: r.person_id, role: r.role, relationship: r.relationship, authority: r.authority,
          validFrom: from, validTo: to, evidenceIds: evidence.filter(e => e.purpose === 'relationship').map(e => e.source_id), authorityEvidenceIds: evidence.filter(e => e.purpose === 'authority').map(e => e.source_id) });
        if (link.kind !== 'person_role') throw Error('invalid_role');
        this.sources(accountId, link.evidenceIds);
        applicable.push(displayRoleSchema.parse({ linkId: link.id, value: link.role, validFrom: from, validTo: to, evidenceIds: link.evidenceIds }));
      }
      if (!applicable.length) { this.issue('role', 'not_recorded'); return null; }
      if (new Set(applicable.map(r => r.value)).size !== 1) { this.issue('role', 'ambiguous'); return null; }
      return applicable[0]!;
    } catch { this.issue('role', 'invalid_source'); return null; }
  }
  contact(accountId: string, routeId: string, routeVersion: number, basis: DisplayContact['basis'], matches: (route: AccountRoute) => boolean): DisplayContact | null {
    const field = basis === 'original_call_route' ? 'call_contact' : 'contact';
    try {
      const route = this.route(accountId, routeId, routeVersion);
      if (!matches(route)) { this.issue(field, 'binding_mismatch'); return null; }
      if (route.personId === null) { this.issue(field, 'not_recorded'); return null; }
      const person = this.one('SELECT id,display_name,version,deleted_at FROM persons WHERE id=?', route.personId);
      if (!person) { this.issue(field, 'source_unavailable'); return null; }
      if (person.deleted_at !== null) { this.issue(field, 'deleted_person'); return null; }
      const contact = displayContactSchema.parse({ basis, personId: person.id, personVersion: person.version, displayName: person.display_name, route, role: null });
      return { ...contact, role: this.role(accountId, contact.personId) };
    } catch { this.issue(field, 'invalid_source'); return null; }
  }
  call(draft: RequestedFollowupDraft): RequestedAnswerPresentation['callContext'] {
    try {
      const ref = draft.originalCall, accountId = draft.accountId;
      const command = this.one('SELECT command_json,fingerprint FROM delegated_commands WHERE workspace_id=? AND account_id=? AND command_id=?', this.workspaceId, accountId, ref.commandId);
      const event = this.one('SELECT event_json FROM delegated_applied_events WHERE workspace_id=? AND account_id=? AND id=?', this.workspaceId, accountId, ref.outcomeEventId);
      const row = this.one(`SELECT h.*,e.event_json,e.id AS event_identity FROM delegated_manual_handoffs h JOIN delegated_applied_events e ON e.id=h.event_id AND e.workspace_id=h.workspace_id AND e.account_id=h.account_id
        WHERE h.workspace_id=? AND h.account_id=? AND h.handoff_id=?`, this.workspaceId, accountId, ref.handoffId);
      if (!command || !event || !row || row.consumed_at === null) { this.issue('call_context', 'source_unavailable'); return null; }
      const handoffEvent = workerEventSchema.parse(JSON.parse(String(row.event_json)));
      if (handoffEvent.kind !== 'manual.handoff' || handoffEvent.id !== row.event_identity || handoffEvent.workspaceId !== this.workspaceId || handoffEvent.accountId !== accountId
        || handoffEvent.authorityGeneration !== row.authority_generation || row.outcome_command_id !== null && row.outcome_command_id !== ref.commandId) throw Error('handoff_scope');
      const h = handoffEvent.payload;
      if (h.handoffId !== row.handoff_id || h.actionId !== row.action_id || h.targetHash !== row.target_hash || h.contentHash !== row.content_hash
        || h.contextRevision !== row.context_revision || h.channel !== row.channel || h.routeId !== row.route_id || h.routeVersion !== row.route_version || h.expiresAt !== row.expires_at) throw Error('handoff_identity');
      const validated = validateRequestedOriginalCall({ workspaceId: this.workspaceId, accountId, reference: ref, command: JSON.parse(String(command.command_json)), commandFingerprint: String(command.fingerprint), event: JSON.parse(String(event.event_json)), handoff: h, handoffAccountId: accountId, handoffGeneration: handoffEvent.authorityGeneration });
      if (validated.event.kind !== 'manual.outcome' || validated.event.payload.observedAt > this.asOf) throw Error('future_outcome');
      const note = validated.event.payload.replyText;
      const invalidNote = note?.includes('\0') ?? false;
      const noteText = !invalidNote && note?.trim() ? note : null;
      if (noteText === null) this.issue('call_note', invalidNote ? 'invalid_source' : 'not_recorded');
      const linkedContact = this.contact(accountId, h.routeId, h.routeVersion, 'original_call_route', r => r.channel === 'phone' && hash(r.value) === h.targetHash);
      return { basis: 'human_reported_call_outcome', originalCall: ref, outcome: 'connected', observedAt: validated.event.payload.observedAt, noteText, linkedContact };
    } catch { this.issue('call_context', 'invalid_source'); return null; }
  }
}
/** Any optional-source failure is local. Core draft/approval validity is decided by the caller first. */
export function withDailyAnswerPresentation(database: AppDatabase, workspaceId: string, asOf: string, answer: DailyAnswer): DailyAnswer {
  if (answer.kind === 'reply') return answer;
  try {
    const reader = new PresentationReader(database, workspaceId, asOf), d = answer.draft;
    if (answer.kind === 'requested_followup' && 'kind' in d) {
      const b = d.recipientBinding;
      const contact = b.kind === 'account_route' ? reader.contact(d.accountId, b.routeId, b.routeVersion, 'recipient_route', r => r.channel === 'email' && r.value === b.email && r.value === d.recipient && r.purpose === 'business' && ['published', 'confirmed'].includes(r.verification)) : null;
      const callContext = reader.call(d);
      if (!contact && !callContext) return answer;
      const { revision, subject, body, evidenceIds, generation, updatedAt, ...identity } = d;
      void [revision, subject, body, evidenceIds, generation, updatedAt];
      const presentation = requestedAnswerPresentationSchema.parse({ kind: answer.kind, asOf, binding: { ...identity, workspaceId }, contact, callContext, issues: reader.issues });
      return dailyAnswerPresentationMatches(presentation, d, workspaceId) ? { ...answer, presentation } : answer;
    }
    if (answer.kind === 'manual_linkedin' && !('kind' in d)) {
      const contact = reader.contact(d.accountId, d.routeId, d.routeVersion, 'manual_route', r => r.channel === 'linkedin' && r.personId === d.personId && hash(r.value) === d.targetHash);
      if (!contact) return answer;
      const { revision, body, contentHash, state, updatedAt, ...binding } = d;
      void [revision, body, contentHash, state, updatedAt];
      const presentation = manualAnswerPresentationSchema.parse({ kind: answer.kind, asOf, binding, contact, issues: reader.issues });
      return dailyAnswerPresentationMatches(presentation, d, workspaceId) ? { ...answer, presentation } : answer;
    }
  } catch { /* Optional decoration must not enter the core invalid-record path. */ }
  return answer;
}
