import { routePolicyReceiptSchema } from '../../delegation/accountRoutePolicyStore';
import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';
import type { AccountRepository } from './accountRepository';
import type { AccountEvidenceSnapshot, AccountRoute } from '../../../shared/contracts/accountContract';
import { accountIdSchema, accountInstantSchema } from '../../../shared/contracts/accountContract';
import { accountFingerprint } from './accountEvidence';
import { PLAYBOOK_CHANNEL_POLICIES_V2, type ChannelPolicySnapshots } from '../cadence/cadenceScheduler';
import { evaluateOutboundAuthorization } from '../compliance/outboundAuthorization';
import { contactComplianceEvidenceSchema } from '../compliance/contactComplianceTypes';
import { handoffResultSchema, type HandoffResult } from '../../../shared/contracts/outboundContract';
import { accountCallEvidenceSchema, accountCallRangeSchema, accountCallReportSchema, accountOutboundReceiptSchema,
  accountOutboundRequestSchema, actualAccountCallOutcomes, type AccountCallRange, type AccountCallReport,
  type AccountCallReportReceipt, type AccountOutboundReceipt, type AccountOutboundRequest,
  type AccountRouteAuthorization, type ActualAccountCallAttempt } from '../../../shared/contracts/accountOutboundContract';

type PhonePolicy = Parameters<typeof evaluateOutboundAuthorization>[0];
/** Trusted main-process read port, never renderer supplied. Must read genuine route-bound
 * compliance, suppression and execution ownership in the caller's SQL transaction.
 * Schema21 supplies immutable policy receipts. Missing evidence always denies. */
export type AccountRoutePolicyEvidence = Pick<PhonePolicy, 'contact' | 'jurisdiction' | 'clearance'> & {
  accountId: string; routeId: string; routeVersion: number; evidenceFingerprint: string;
  evidenceRef: string; ownerGeneration: string; ownerEnabled: boolean;
  suppression: { account: boolean; person: boolean; handle: boolean };
};
export interface AccountRoutePolicyPort {
  read(snapshot: AccountEvidenceSnapshot, route: AccountRoute): AccountRoutePolicyEvidence | null;
}
function legacyRouteSuppression(database: AppDatabase, route: AccountRoute, at: string) {
  const raw = database.raw;
  const handle = !!raw.prepare('SELECT 1 FROM opt_out_handles WHERE kind=? AND normalized_value=? LIMIT 1').get(route.channel, route.value);
  const person = !!raw.prepare(`SELECT 1 FROM persons p WHERE (p.opted_out=1 OR p.deleted_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM opt_out_tombstones t WHERE t.person_id=p.id)) AND
    (p.id=? OR EXISTS(SELECT 1 FROM person_contact_methods c WHERE c.person_id=p.id AND c.kind=? AND c.normalized_value=?)
    OR EXISTS(SELECT 1 FROM pm_account_links l WHERE l.account_id=? AND l.person_id=p.id AND l.admitted_at<=?
      AND l.valid_from<=? AND (l.valid_to IS NULL OR l.valid_to>?))) LIMIT 1`)
    .get(route.personId, route.channel, route.value, route.accountId, at, at, at);
  return { person, handle };
}

/** Read-only production binding. Admission remains AccountRoutePolicyStore's separately
 * attested capability. This never creates evidence or initializes execution ownership. */
export function createSqlAccountRoutePolicy(input: { database: AppDatabase; clock: Clock; expectedWorkspaceId?: string }): AccountRoutePolicyPort {
  const { database, clock, expectedWorkspaceId } = input;
  return { read(snapshot, route) {
    const raw = database.raw;
    if (!raw.inTransaction) throw new Error('Account policy read requires the authorization transaction');
    if (!accountIdSchema.safeParse(expectedWorkspaceId).success) return null;
    const at = accountInstantSchema.parse(clock.now());
    // Select latest first, then validate. Never fall back past a newer expired/blocked receipt.
    const row = raw.prepare(`SELECT * FROM pm_account_route_policy_receipts
      WHERE account_id=? AND route_id=? AND route_version=? ORDER BY revision DESC LIMIT 1`)
      .get(snapshot.account.id, route.id, route.version) as {
        id: string; account_id: string; route_id: string; route_version: number; canonical_target: string; evidence_fingerprint: string;
        revision: number; evidence_ref: string; provenance: string; observed_at: string; admitted_at: string;
        effective_at: string; expires_at: string; policy_json: string; receipt_fingerprint: string;
      } | undefined;
    if (!row) return null;
    const evidenceIds = (raw.prepare('SELECT source_id FROM pm_account_route_policy_evidence WHERE receipt_id=? ORDER BY source_id').all(row.id) as { source_id: string }[]).map(value => value.source_id);
    let parsed: ReturnType<typeof routePolicyReceiptSchema.safeParse>;
    try { parsed = routePolicyReceiptSchema.safeParse({ id: row.id, accountId: row.account_id, routeId: row.route_id, routeVersion: row.route_version,
      canonicalTarget: row.canonical_target, evidenceFingerprint: row.evidence_fingerprint, revision: row.revision,
      evidenceRef: row.evidence_ref, evidenceIds, provenance: row.provenance, observedAt: row.observed_at,
      effectiveAt: row.effective_at, expiresAt: row.expires_at, policy: JSON.parse(row.policy_json) }); } catch { return null; }
    if (!parsed.success || !accountInstantSchema.safeParse(row.admitted_at).success || !/^[a-f0-9]{64}$/.test(row.receipt_fingerprint)) return null;
    const receipt = parsed.data;
    if (receipt.canonicalTarget !== route.value || receipt.policy.contact.normalizedValue !== route.value || receipt.policy.contact.kind !== route.channel
      || receipt.evidenceFingerprint !== snapshot.fingerprint || receipt.observedAt > at || row.admitted_at > at
      || receipt.effectiveAt > at || receipt.expiresAt <= at || receipt.expiresAt <= receipt.effectiveAt) return null;
    for (const sourceId of [...evidenceIds, receipt.evidenceRef]) {
      if (!raw.prepare('SELECT 1 FROM pm_account_sources WHERE account_id=? AND id=? AND fetched_at<=? AND admitted_at<=?')
        .get(route.accountId, sourceId, receipt.observedAt, at)) return null;
    }
    const owner = raw.prepare('SELECT workspace_id,owner,generation,state,updated_at FROM delegated_authorities WHERE account_id=?').get(route.accountId) as {
      workspace_id: string; owner: string; generation: number; state: string; updated_at: string;
    } | undefined;
    if (!owner || owner.workspace_id !== expectedWorkspaceId || !accountIdSchema.safeParse(owner.workspace_id).success || !Number.isSafeInteger(owner.generation) || owner.generation < 0
      || !accountInstantSchema.safeParse(owner.updated_at).success || owner.updated_at > at) return null;
    const legacy = legacyRouteSuppression(database, route, at);
    return {
      accountId: route.accountId, routeId: route.id, routeVersion: route.version, evidenceFingerprint: snapshot.fingerprint,
      // Immutable receipt ID freezes the selected compliance revision/provenance in contextRevision.
      evidenceRef: receipt.id, ownerGeneration: accountFingerprint({ workspaceId: owner.workspace_id, owner: owner.owner, generation: owner.generation, state: owner.state }),
      ownerEnabled: owner.owner === 'local' && owner.state === 'local',
      suppression: { account: !!raw.prepare('SELECT 1 FROM pm_account_suppression_tombstones WHERE account_id=? LIMIT 1').get(route.accountId),
        person: legacy.person, handle: legacy.handle || !!raw.prepare('SELECT 1 FROM pm_handle_suppression_tombstones WHERE kind=? AND normalized_value=? LIMIT 1').get(route.channel, route.value) },
      contact: receipt.policy.contact as AccountRoutePolicyEvidence['contact'], jurisdiction: receipt.policy.jurisdiction as AccountRoutePolicyEvidence['jurisdiction'],
      clearance: receipt.policy.clearance as AccountRoutePolicyEvidence['clearance'],
    };
  } };
}

export function authorizeAccountRoute(input: {
  request: AccountOutboundRequest; route: AccountRoute | null; evidenceFingerprint: string;
  policy: AccountRoutePolicyEvidence | null; expectedOwnerGeneration: string | null; now: string; windows: ChannelPolicySnapshots;
}): AccountRouteAuthorization {
  const { request, route, policy } = input;
  const blocked = (reason: string): AccountRouteAuthorization => ({ kind: 'blocked', reason });
  if (request.channel === 'email') return blocked('email_execution_unavailable');
  if (!route || route.accountId !== request.accountId || route.id !== request.routeId || route.version !== request.expectedRouteVersion) return blocked('stale_route');
  if (input.evidenceFingerprint !== request.expectedEvidenceFingerprint) return blocked('stale_evidence');
  if (route.purpose !== 'business') return blocked('route_not_business');
  if (route.channel !== 'phone' || route.value.match(/^\+[1-9][0-9]{7,14}$/)?.[0] !== route.value) return blocked('invalid_target');
  if (route.verification === 'unverified' || route.evidenceIds.length === 0) return blocked('route_unverified');
  if (!policy) return blocked('account_policy_evidence_unavailable');
  if (policy.suppression.account !== false || policy.suppression.person !== false || policy.suppression.handle !== false) return blocked('account_or_route_opted_out');
  if (policy.accountId !== route.accountId || policy.routeId !== route.id || policy.routeVersion !== route.version
    || policy.evidenceFingerprint !== input.evidenceFingerprint || !policy.evidenceRef?.trim()
    || policy.contact.normalizedValue !== route.value) return blocked('account_policy_evidence_stale');
  if (policy.ownerEnabled !== true || !policy.ownerGeneration?.trim() || policy.ownerGeneration !== input.expectedOwnerGeneration) return blocked('account_owner_changed');
  if (!contactComplianceEvidenceSchema.safeParse(policy.contact.evidence).success) return blocked('account_policy_evidence_invalid');
  const decision = evaluateOutboundAuthorization({ channel: 'call', now: input.now, personOrHandleOptedOut: false,
    contact: policy.contact, jurisdiction: policy.jurisdiction, clearance: policy.clearance, windows: input.windows });
  if (decision.kind !== 'allowed') return blocked(decision.reasonCode);
  return { kind: 'allowed', canonicalTarget: route.value,
    contextRevision: accountFingerprint({ request, policy, windows: input.windows, now: input.now }) };
}

type Intent = { command_id: string; account_id: string; attempt_id: string; command_fingerprint: string; channel: 'call' | 'email'; canonical_target: string };
type ResultRow = { result_json: string; created_at: string; outcome: string };
export type AccountReservation = { kind: 'receipt'; receipt: AccountOutboundReceipt } |
  { kind: 'dispatch'; receipt: AccountOutboundReceipt; canonicalTarget: string };
const commandFingerprint = (request: AccountOutboundRequest) => accountFingerprint({ kind: 'account_outbound_v1', request });

/** Reads only B4's versioned explicit reports, never legacy metadata or dispatch status. */
export function listActualCallAttempts(database: AppDatabase, input: AccountCallRange): ActualAccountCallAttempt[] {
  const range = accountCallRangeSchema.parse(input);
  const rows = database.raw.prepare(`SELECT r.account_id,r.command_id,r.attempt_id,r.result_json,r.outcome,r.created_at
    FROM pm_account_outbound_results r JOIN pm_account_outbound_intents i
    ON i.command_id=r.command_id AND i.attempt_id=r.attempt_id AND i.account_id=r.account_id
    WHERE r.kind='call_outcome' AND i.channel='call' AND r.created_at>=? AND r.created_at<?
    AND EXISTS (SELECT 1 FROM pm_account_outbound_results d
      WHERE d.command_id=r.command_id AND d.attempt_id=r.attempt_id AND d.account_id=r.account_id
      AND d.kind='dispatch' AND d.outcome IN ('handoff_accepted','unknown'))
    ORDER BY r.created_at,r.id`).all(range.from, range.to) as
    (ResultRow & { account_id: string; command_id: string; attempt_id: string })[];
  const seen = new Set<string>();
  return rows.flatMap(row => {
    let evidence: ReturnType<typeof accountCallEvidenceSchema.safeParse>;
    try { evidence = accountCallEvidenceSchema.safeParse(JSON.parse(row.result_json)); } catch { return []; }
    if (!evidence.success || evidence.data.outcome !== row.outcome || !actualAccountCallOutcomes.some(o => o === row.outcome) || seen.has(row.attempt_id)) return [];
    seen.add(row.attempt_id);
    return [{ accountId: row.account_id, commandId: row.command_id, attemptId: row.attempt_id,
      outcome: row.outcome as ActualAccountCallAttempt['outcome'], reportedAt: row.created_at }];
  });
}

export class AccountOutreach {
  constructor(private readonly deps: { database: AppDatabase; accounts: AccountRepository; clock: Clock; ids: IdGenerator; policy?: AccountRoutePolicyPort }) {}
  private get raw() { return this.deps.database.raw; }
  private atomic<T>(run: () => T): T {
    if (this.raw.inTransaction) throw new Error('Account outbound requires its own scoped transaction');
    return this.raw.transaction(run).immediate();
  }
  private now() { return accountInstantSchema.parse(this.deps.clock.now()); }
  private intent(commandId: string): Intent | undefined {
    return this.raw.prepare('SELECT * FROM pm_account_outbound_intents WHERE command_id=?').get(commandId) as Intent | undefined;
  }
  private receipt(intent: Intent): AccountOutboundReceipt {
    const result = this.raw.prepare("SELECT result_json FROM pm_account_outbound_results WHERE command_id=? AND kind='dispatch' ORDER BY rowid LIMIT 1").get(intent.command_id) as ResultRow | undefined;
    if (result) return accountOutboundReceiptSchema.parse(JSON.parse(result.result_json)) as AccountOutboundReceipt;
    return { commandId: intent.command_id, accountId: intent.account_id, attemptId: intent.attempt_id, status: 'unknown', reason: 'handoff_uncertain' };
  }
  inspect(request: AccountOutboundRequest): AccountOutboundReceipt | null {
    request = accountOutboundRequestSchema.parse(request);
    const fingerprint = commandFingerprint(request);
    const command = this.raw.prepare('SELECT fingerprint,result_json FROM pm_account_commands WHERE command_id=?').get(request.commandId) as { fingerprint: string; result_json: string } | undefined;
    if (!command) return null;
    if (command.fingerprint !== fingerprint) throw new Error('Account outbound command conflict');
    const intent = this.intent(request.commandId);
    return intent ? this.receipt(intent) : accountOutboundReceiptSchema.parse(JSON.parse(command.result_json)) as AccountOutboundReceipt;
  }
  private context(request: AccountOutboundRequest, at: string) {
    const snapshot = this.deps.accounts.snapshot(request.accountId, at);
    const route = snapshot.routes.find(r => r.id === request.routeId) ?? null;
    const policy = route ? this.deps.policy?.read(snapshot, route) ?? null : null;
    return { snapshot, route, policy };
  }
  ownerGeneration(request: AccountOutboundRequest): string | null {
    request = accountOutboundRequestSchema.parse(request);
    return this.atomic(() => this.context(request, this.now()).policy?.ownerGeneration ?? null);
  }
  private storeCommand(request: AccountOutboundRequest, receipt: AccountOutboundReceipt, version: number, at: string) {
    this.raw.prepare('INSERT INTO pm_account_commands(command_id,account_id,fingerprint,result_json,account_version,created_at) VALUES(?,?,?,?,?,?)')
      .run(request.commandId, request.accountId, commandFingerprint(request), JSON.stringify(receipt), version, at);
  }
  private refusal(request: AccountOutboundRequest, reason: string, version: number, at: string): AccountOutboundReceipt {
    const receipt: AccountOutboundReceipt = { commandId: request.commandId, accountId: request.accountId, attemptId: null, status: 'refused', reason };
    accountOutboundReceiptSchema.parse(receipt); this.storeCommand(request, receipt, version, at); return receipt;
  }
  recordRefusal(request: AccountOutboundRequest, reason: string): AccountOutboundReceipt {
    request = accountOutboundRequestSchema.parse(request);
    return this.atomic(() => {
      const previous = this.inspect(request); if (previous) return previous;
      const at = this.now(); const snapshot = this.deps.accounts.snapshot(request.accountId, at);
      return this.refusal(request, reason, snapshot.account.version, at);
    });
  }
  private legacySuppressed(route: AccountRoute, at: string): boolean {
    const suppression = legacyRouteSuppression(this.deps.database, route, at);
    return suppression.person || suppression.handle;
  }
  private retainedHandleRestriction(route: AccountRoute, at: string): string | null {
    if (this.legacySuppressed(route, at)) return 'account_or_route_opted_out';
    if (route.channel !== 'phone') return null;
    // A company receipt cannot silently clear a retained person-contact restriction
    // on the same canonical handle. Use the existing authoritative correction path.
    if (this.raw.prepare("SELECT 1 FROM person_contact_methods WHERE kind='phone' AND normalized_value=? AND (dnc_listed=1 OR federal_status='listed') LIMIT 1").get(route.value)) return 'federal_dnc_listed';
    if (this.raw.prepare("SELECT 1 FROM person_contact_methods WHERE kind='phone' AND normalized_value=? AND (tcpa_flag=1 OR compliance_tcpa_flag=1) LIMIT 1").get(route.value)) return 'tcpa_blocked';
    return null;
  }
  reserve(request: AccountOutboundRequest, expectedOwnerGeneration: string | null): AccountReservation {
    request = accountOutboundRequestSchema.parse(request);
    return this.atomic(() => {
      const previous = this.inspect(request); if (previous) return { kind: 'receipt', receipt: previous };
      const at = this.now(); const { snapshot, route, policy } = this.context(request, at);
      const restriction = route ? this.retainedHandleRestriction(route, at) : null;
      const authorization = restriction
        ? { kind: 'blocked' as const, reason: restriction }
        : authorizeAccountRoute({ request, route, policy, expectedOwnerGeneration, evidenceFingerprint: snapshot.fingerprint, now: at, windows: PLAYBOOK_CHANNEL_POLICIES_V2 });
      if (authorization.kind === 'blocked') return { kind: 'receipt', receipt: this.refusal(request, authorization.reason, snapshot.account.version, at) };
      const receipt: AccountOutboundReceipt = { commandId: request.commandId, accountId: request.accountId, attemptId: this.deps.ids.next(), status: 'unknown', reason: 'handoff_uncertain' };
      this.storeCommand(request, receipt, snapshot.account.version, at);
      this.raw.prepare(`INSERT INTO pm_account_outbound_intents(command_id,account_id,route_id,route_version,account_version,evidence_fingerprint,
        command_fingerprint,attempt_id,channel,canonical_target,context_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(request.commandId, request.accountId, request.routeId, request.expectedRouteVersion, snapshot.account.version, request.expectedEvidenceFingerprint,
          commandFingerprint(request), receipt.attemptId, request.channel, authorization.canonicalTarget, authorization.contextRevision, at);
      return { kind: 'dispatch', receipt, canonicalTarget: authorization.canonicalTarget };
    });
  }
  recordDispatch(request: AccountOutboundRequest, result: HandoffResult): AccountOutboundReceipt {
    request = accountOutboundRequestSchema.parse(request);
    return this.atomic(() => {
      this.inspect(request); const intent = this.intent(request.commandId);
      if (!intent) throw new Error('Account outbound intent missing');
      const existing = this.raw.prepare("SELECT 1 FROM pm_account_outbound_results WHERE command_id=? AND kind='dispatch'").get(request.commandId);
      if (existing) return this.receipt(intent);
      const parsed = handoffResultSchema.safeParse(result);
      const value: HandoffResult = parsed.success ? parsed.data as HandoffResult : { status: 'unknown', reasonCode: 'handoff_uncertain' };
      const receipt: AccountOutboundReceipt = { commandId: request.commandId, accountId: request.accountId, attemptId: intent.attempt_id, status: value.status, reason: value.reasonCode };
      this.raw.prepare("INSERT INTO pm_account_outbound_results(id,command_id,attempt_id,account_id,kind,outcome,result_json,created_at) VALUES(?,?,?,?,'dispatch',?,?,?)")
        .run(this.deps.ids.next(), request.commandId, intent.attempt_id, intent.account_id, value.status, JSON.stringify(receipt), this.now());
      return receipt;
    });
  }
  reportCallOutcome(input: AccountCallReport): AccountCallReportReceipt {
    const report = accountCallReportSchema.parse(input) as AccountCallReport;
    return this.atomic(() => {
      const intent = this.intent(report.commandId);
      if (!intent || intent.attempt_id !== report.attemptId || intent.channel !== 'call') throw new Error('Account call attempt not found');
      const dispatch = this.raw.prepare("SELECT outcome FROM pm_account_outbound_results WHERE command_id=? AND kind='dispatch' ORDER BY rowid LIMIT 1").get(report.commandId) as { outcome: string } | undefined;
      if (!dispatch || !['handoff_accepted', 'unknown'].includes(dispatch.outcome)) throw new Error('Account call not attempted');
      const evidence = { version: 1, source: 'user_report', outcome: report.outcome, notes: report.notes };
      const existing = this.raw.prepare("SELECT result_json,created_at FROM pm_account_outbound_results WHERE command_id=? AND kind='call_outcome' ORDER BY rowid LIMIT 1").get(report.commandId) as ResultRow | undefined;
      if (existing && accountFingerprint(JSON.parse(existing.result_json)) !== accountFingerprint(evidence)) throw new Error('Account call outcome conflict');
      const reportedAt = existing?.created_at ?? this.now();
      if (!existing) this.raw.prepare("INSERT INTO pm_account_outbound_results(id,command_id,attempt_id,account_id,kind,outcome,result_json,created_at) VALUES(?,?,?,?,'call_outcome',?,?,?)")
        .run(this.deps.ids.next(), report.commandId, report.attemptId, intent.account_id, report.outcome, JSON.stringify(evidence), reportedAt);
      return { ...report, accountId: intent.account_id, reportedAt };
    });
  }
  listActualCallAttempts(input: AccountCallRange): ActualAccountCallAttempt[] { return listActualCallAttempts(this.deps.database, input); }
}
