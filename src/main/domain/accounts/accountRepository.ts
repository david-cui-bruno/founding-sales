import { localCompanyInputSchema, localCompanyCandidateSignals, localCompanyReviewSchema, type LocalCompanyInput, type LocalCompanyCreateRequest, type LocalCompanyReview, type LocalCompanyCreateResult, type LocalCompanyCreateStatus } from '../../../shared/contracts/localCompanyIntakeContract';
import { accountEvidenceReceiptSchema, localCompanyDetailSchema, localCompanyResearchStatusSchema, selectedResearchSchema,
  type LocalCompanyDetail, type LocalCompanyResearchStatus, type SelectedResearch } from '../../../shared/contracts/localWorkspaceContract';
import { z } from 'zod';
import { researchLimitsSchema, type AccountResearchStore, type ResearchJob, type ResearchClaim } from '../../research/companyResearchTypes';
import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';
import { accountClaimSchema, accountCreateSchema, accountEvidenceBatchSchema, accountIdSchema, accountInstantSchema,
  accountLinkSchema, accountLinksCommandSchema, accountRouteSchema, accountSchema, accountSourceSchema,
  type Account, type AccountEvidenceBatch, type AccountEvidenceReceipt, type AccountEvidenceSnapshot, type AccountLink, type AccountSource } from '../../../shared/contracts/accountContract';
import { accountFingerprint, projectAccountEvidence } from './accountEvidence';

/** Main-process composition capability. B2 must attest fetched receipts out-of-band,
 * not echo the model's permitted flag. Unconfigured admission fails closed. */
export interface AccountSourcePolicy { attest(source: Readonly<AccountSource>, accountId: string): boolean; }
type Dependencies = { database: AppDatabase; clock: Clock; ids: IdGenerator; sourcePolicy?: AccountSourcePolicy; research?: { maxBudgetMicros: number; leaseMs?: number } };
type Command = { commandId: string; accountId: string; expectedVersion: number };
type ReceiptRow = { fingerprint: string; result_json: string };

export class AccountRepository implements AccountResearchStore {
  constructor(private readonly deps: Dependencies) {}
  private get raw() { return this.deps.database.raw; }
  private atomic<T>(run: () => T): T {
    if (this.raw.inTransaction) throw new Error('Account command requires its own scoped transaction');
    return this.raw.transaction(run).immediate();
  }
  /** Read-only snapshots may join the consumer's final authorization transaction. */
  private readSnapshot<T>(read: () => T): T {
    return this.raw.inTransaction ? read() : this.raw.transaction(read).deferred();
  }
  private now(): string { return accountInstantSchema.parse(this.deps.clock.now()); }
  private replay(commandId: string, fingerprint: string): unknown | undefined {
    const previous = this.raw.prepare('SELECT fingerprint,result_json FROM pm_account_commands WHERE command_id=?').get(commandId) as ReceiptRow | undefined;
    if (!previous) return undefined;
    if (previous.fingerprint !== fingerprint) throw new Error('Account command fingerprint conflict');
    return JSON.parse(previous.result_json);
  }
  private record(commandId: string, accountId: string, fingerprint: string, result: unknown, version: number, at: string) {
    this.raw.prepare('INSERT INTO pm_account_commands(command_id,account_id,fingerprint,result_json,account_version,created_at) VALUES(?,?,?,?,?,?)')
      .run(commandId, accountId, fingerprint, JSON.stringify(result), version, at);
  }
  private account(id: string): Account {
    const row = this.raw.prepare('SELECT id,name,domain,version FROM pm_accounts WHERE id=?').get(id);
    if (!row) throw new Error('Account not found');
    return accountSchema.parse(row);
  }
  create(input: z.infer<typeof accountCreateSchema>): Account {
    const parsed = accountCreateSchema.parse(input);
    const fingerprint = accountFingerprint({ kind: 'create', ...parsed });
    return this.atomic(() => {
      const replay = this.replay(parsed.commandId, fingerprint);
      if (replay !== undefined) return accountSchema.parse(replay);
      return this.createInTransaction(parsed, fingerprint);
    });
  }
  private createInTransaction(parsed: LocalCompanyCreateRequest, fingerprint: string): Account {
    const at = this.now();
    const account = accountSchema.parse({ id: this.deps.ids.next(), name: parsed.name, domain: parsed.domain, version: 1 });
    this.raw.prepare('INSERT INTO pm_accounts(id,name,domain,version,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(account.id, account.name, account.domain, at, at);
    this.record(parsed.commandId, account.id, fingerprint, account, 1, at);
    return account;
  }
  reviewLocalCompany(input: LocalCompanyInput): LocalCompanyReview {
    const parsed = localCompanyInputSchema.parse(input);
    // SQLite lower is ASCII-only. Explicit trim characters mirror ECMAScript trim,
    // including historical rows not written through today's canonical schema.
    const whitespace = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    const name = parsed.name.replace(/[A-Z]/g, letter => letter.toLowerCase());
    const rows = this.raw.prepare('SELECT id,name,domain,version FROM pm_accounts WHERE lower(trim(name,?))=? OR (? IS NOT NULL AND domain=?) ORDER BY id LIMIT 51')
      .all(whitespace, name, parsed.domain, parsed.domain);
    const candidates = rows.map(row => { const account = accountSchema.parse(row); return { account, signals: localCompanyCandidateSignals(parsed, account) }; });
    return localCompanyReviewSchema.parse({ scope: 'local_database', input: parsed, candidates: candidates.slice(0, 50), complete: candidates.length <= 50 });
  }
  getLocalCompanyCreateStatus(input: LocalCompanyCreateRequest): LocalCompanyCreateStatus {
    const parsed = accountCreateSchema.parse(input);
    const previous = this.raw.prepare('SELECT account_id,account_version,fingerprint,result_json FROM pm_account_commands WHERE command_id=?').get(parsed.commandId) as (ReceiptRow & { account_id: string; account_version: number }) | undefined;
    if (!previous) return { status: 'not_recorded', commandId: parsed.commandId };
    if (previous.fingerprint !== accountFingerprint({ kind: 'create', ...parsed })) return { status: 'command_conflict', commandId: parsed.commandId };
    const account = accountSchema.parse(JSON.parse(previous.result_json));
    if (account.id !== previous.account_id || previous.account_version !== 1 || account.version !== 1 || account.name !== parsed.name || account.domain !== parsed.domain) throw new Error('Invalid original company creation receipt');
    return { status: 'saved', commandId: parsed.commandId, account };
  }
  createLocalCompany(input: LocalCompanyCreateRequest): LocalCompanyCreateResult {
    const parsed = accountCreateSchema.parse(input);
    return this.atomic(() => {
      const previous = this.getLocalCompanyCreateStatus(parsed);
      if (previous.status === 'saved') return { ...previous, replayed: true };
      if (previous.status === 'command_conflict') return previous;
      const review = this.reviewLocalCompany({ name: parsed.name, domain: parsed.domain });
      if (!review.complete || review.candidates.length > 0) return { status: 'needs_review', commandId: parsed.commandId, review };
      const account = this.createInTransaction(parsed, accountFingerprint({ kind: 'create', ...parsed }));
      return { status: 'saved', commandId: parsed.commandId, account, replayed: false };
    });
  }
  private mutate(command: Command, kind: string, input: unknown, apply: (at: string) => void, researchClaim?: ResearchClaim): AccountEvidenceReceipt {
    const fingerprint = accountFingerprint({ kind, input });
    return this.atomic(() => {
      const job = this.raw.prepare('SELECT id,account_id,state,claim_token,receipt_command_id FROM pm_account_research_jobs WHERE id=?').get(command.commandId) as {
        id: string; account_id: string; state: string; claim_token: string; receipt_command_id: string | null;
      } | undefined;
      if (job || researchClaim) {
        if (!job || kind !== 'evidence' || job.account_id !== command.accountId || researchClaim?.jobId !== job.id || researchClaim.claimToken !== job.claim_token
          || (job.state !== 'running' && job.receipt_command_id !== command.commandId)) throw new Error('Research claim fenced');
      }
      const replay = this.replay(command.commandId, fingerprint);
      if (replay !== undefined) return { ...accountEvidenceReceiptSchema.parse(replay), duplicate: true };
      const current = this.account(command.accountId);
      if (current.version !== command.expectedVersion) throw new Error('Stale account version');
      const at = this.now();
      apply(at);
      const result = { accountId: current.id, version: current.version + 1, duplicate: false };
      const updated = this.raw.prepare('UPDATE pm_accounts SET version=?,updated_at=? WHERE id=? AND version=?')
        .run(result.version, at, current.id, command.expectedVersion);
      if (updated.changes !== 1) throw new Error('Stale account version');
      this.record(command.commandId, current.id, fingerprint, result, result.version, at);
      if (job) this.raw.prepare('UPDATE pm_account_research_jobs SET receipt_command_id=? WHERE id=? AND claim_token=?').run(command.commandId, job.id, researchClaim!.claimToken);
      return result;
    });
  }
  private requireEvidence(accountId: string, ids: readonly string[], at: string) {
    for (const id of ids) {
      if (!this.raw.prepare('SELECT 1 FROM pm_account_sources WHERE account_id=? AND id=? AND fetched_at<=? AND admitted_at<=?').get(accountId, id, at, at)) {
        throw new Error('Missing or cross-account evidence');
      }
    }
  }
  admitEvidence(input: AccountEvidenceBatch, researchClaim?: ResearchClaim): AccountEvidenceReceipt {
    const batch = accountEvidenceBatchSchema.parse(input);
    return this.mutate(batch, 'evidence', batch, at => {
      for (const source of batch.sources) {
        if (!source.permitted || source.fetchedAt > at || this.deps.sourcePolicy?.attest(Object.freeze({ ...source }), batch.accountId) !== true) throw new Error('Source policy attestation required');
        const sourceKey = accountFingerprint({ url: source.url, sha256: source.sha256, fetchedAt: source.fetchedAt });
        const existing = this.raw.prepare('SELECT account_id,source_key,excerpt FROM pm_account_sources WHERE id=?').get(source.id) as { account_id: string; source_key: string; excerpt: string } | undefined;
        if (existing) {
          if (existing.account_id !== batch.accountId || existing.source_key !== sourceKey || existing.excerpt !== source.excerpt) throw new Error('Source evidence identity conflict');
          continue;
        }
        this.raw.prepare('INSERT INTO pm_account_sources(id,account_id,source_key,url,fetched_at,sha256,excerpt,permitted,admitted_at) VALUES(?,?,?,?,?,?,?,1,?)')
          .run(source.id, batch.accountId, sourceKey, source.url, source.fetchedAt, source.sha256, source.excerpt, at);
      }
      for (const claim of batch.claims) {
        this.requireEvidence(batch.accountId, claim.evidenceIds, at);
        const id = this.deps.ids.next();
        this.raw.prepare('INSERT INTO pm_account_claims(id,account_id,claim_json,admitted_at) VALUES(?,?,?,?)').run(id, batch.accountId, JSON.stringify(claim), at);
        for (const source of claim.evidenceIds) this.raw.prepare('INSERT INTO pm_account_claim_evidence(account_id,claim_id,source_id) VALUES(?,?,?)').run(batch.accountId, id, source);
      }
      for (const route of batch.routes) {
        if (route.accountId !== batch.accountId) throw new Error('Cross-account route');
        this.requireEvidence(batch.accountId, route.evidenceIds, at);
        const old = this.raw.prepare('SELECT account_id,MAX(version) AS version FROM pm_account_routes WHERE id=? GROUP BY account_id').get(route.id) as { account_id: string; version: number } | undefined;
        if (old && old.account_id !== batch.accountId) throw new Error('Cross-account route identity');
        const version = (old?.version ?? 0) + 1;
        this.raw.prepare('INSERT INTO pm_account_routes(id,account_id,version,person_id,channel,value,purpose,verification,admitted_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(route.id, batch.accountId, version, route.personId, route.channel, route.value, route.purpose, route.verification, at);
        for (const source of route.evidenceIds) this.raw.prepare('INSERT INTO pm_account_route_evidence(account_id,route_id,route_version,source_id) VALUES(?,?,?,?)').run(batch.accountId, route.id, version, source);
      }
    }, researchClaim);
  }
  admitLinks(input: z.infer<typeof accountLinksCommandSchema>): AccountEvidenceReceipt {
    const command = accountLinksCommandSchema.parse(input);
    return this.mutate(command, 'links', command, at => {
      for (const link of command.links) {
        this.requireEvidence(command.accountId, link.evidenceIds, at);
        if (link.kind === 'person_role') this.requireEvidence(command.accountId, link.authorityEvidenceIds, at);
        this.raw.prepare(`INSERT INTO pm_account_links(id,account_id,kind,organization_id,person_id,property_id,relationship,role,authority,valid_from,valid_to,admitted_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(link.id, command.accountId, link.kind,
          link.kind === 'organization' ? link.organizationId : null, link.kind === 'person_role' ? link.personId : null,
          link.kind === 'property' ? link.propertyId : null, link.relationship, link.kind === 'person_role' ? link.role : null,
          link.kind === 'person_role' ? link.authority : null, link.validFrom, link.validTo, at);
        for (const source of link.evidenceIds) this.raw.prepare("INSERT INTO pm_account_link_evidence VALUES(?,?,?,'relationship')").run(command.accountId, link.id, source);
        if (link.kind === 'person_role') for (const source of link.authorityEvidenceIds) this.raw.prepare("INSERT INTO pm_account_link_evidence VALUES(?,?,?,'authority')").run(command.accountId, link.id, source);
      }
    });
  }
  listLinks(accountId: string, asOf: string): AccountLink[] {
    accountIdSchema.parse(accountId); accountInstantSchema.parse(asOf);
    const rows = this.raw.prepare('SELECT * FROM pm_account_links WHERE account_id=? AND admitted_at<=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) ORDER BY id').all(accountId, asOf, asOf, asOf) as {
      id: string; kind: AccountLink['kind']; organization_id: string | null; person_id: string | null; property_id: string | null;
      relationship: string; role: string | null; authority: string | null; valid_from: string; valid_to: string | null;
    }[];
    return rows.map(row => {
      const evidence = this.raw.prepare('SELECT source_id,purpose FROM pm_account_link_evidence WHERE account_id=? AND link_id=? ORDER BY source_id').all(accountId, row.id) as { source_id: string; purpose: string }[];
      return accountLinkSchema.parse({ id: row.id, kind: row.kind, relationship: row.relationship, validFrom: row.valid_from, validTo: row.valid_to,
        evidenceIds: evidence.filter(e => e.purpose === 'relationship').map(e => e.source_id),
        ...(row.kind === 'organization' ? { organizationId: row.organization_id } : row.kind === 'property' ? { propertyId: row.property_id }
          : { personId: row.person_id, role: row.role, authority: row.authority, authorityEvidenceIds: evidence.filter(e => e.purpose === 'authority').map(e => e.source_id) }) });
    });
  }
  snapshot(accountId: string, asOf: string): AccountEvidenceSnapshot {
    accountIdSchema.parse(accountId); accountInstantSchema.parse(asOf);
    return this.readSnapshot(() => {
      const account = this.account(accountId);
      const version = this.raw.prepare('SELECT MAX(account_version) AS version FROM pm_account_commands WHERE account_id=? AND created_at<=?').get(accountId, asOf) as { version: number | null };
      if (version.version === null) throw new Error('Account not found as of instant');
      account.version = version.version;
      const claims = (this.raw.prepare('SELECT claim_json FROM pm_account_claims WHERE account_id=? AND admitted_at<=? ORDER BY rowid').all(accountId, asOf) as { claim_json: string }[])
        .map(row => accountClaimSchema.parse(JSON.parse(row.claim_json)));
      const rows = this.raw.prepare(`SELECT r.* FROM pm_account_routes r WHERE account_id=? AND admitted_at<=?
        AND version=(SELECT MAX(version) FROM pm_account_routes newer WHERE newer.id=r.id AND newer.admitted_at<=?) ORDER BY r.rowid`).all(accountId, asOf, asOf) as {
          id: string; version: number; person_id: string | null; channel: string; value: string; purpose: string; verification: string;
        }[];
      const routes = rows.map(row => accountRouteSchema.parse({ id: row.id, accountId, version: row.version, personId: row.person_id,
        channel: row.channel, value: row.value, purpose: row.purpose, verification: row.verification,
        evidenceIds: (this.raw.prepare('SELECT source_id FROM pm_account_route_evidence WHERE account_id=? AND route_id=? AND route_version=? ORDER BY source_id').all(accountId, row.id, row.version) as { source_id: string }[]).map(e => e.source_id) }));
      return projectAccountEvidence(account, claims, routes);
    });
  }
  /** Complete selected evidence in one read snapshot, including a caller-owned transaction. */
  readLocalCompanyDetail(accountId: string, asOf: string): LocalCompanyDetail {
    accountIdSchema.parse(accountId); accountInstantSchema.parse(asOf);
    return this.readSnapshot(() => {
      const snapshot = this.snapshot(accountId, asOf);
      if (snapshot.account.id !== accountId) throw new Error('Selected company identity mismatch');
      const rows = this.raw.prepare(`SELECT id,url,fetched_at AS fetchedAt,sha256,excerpt,permitted
        FROM pm_account_sources WHERE account_id=? AND admitted_at<=? ORDER BY id`).all(accountId, asOf) as Record<string, unknown>[];
      const sources = rows.map(row => accountSourceSchema.parse({ ...row, permitted: z.literal(1).parse(row.permitted) === 1 }));
      const links = this.listLinks(accountId, asOf);
      return localCompanyDetailSchema.parse({ scope: 'local_database', generatedAt: asOf, snapshot, sources, links });
    });
  }
  enqueue(input: Parameters<AccountResearchStore['enqueue']>[0]): void {
    const parsed = z.strictObject({ commandId: z.uuid(), accountId: accountIdSchema, limits: researchLimitsSchema }).parse(input);
    const fingerprint = accountFingerprint({ accountId: parsed.accountId, limits: parsed.limits });
    this.atomic(() => {
      const old = this.raw.prepare('SELECT fingerprint FROM pm_account_research_jobs WHERE command_id=?').get(parsed.commandId) as { fingerprint: string } | undefined;
      if (old) { if (old.fingerprint !== fingerprint) throw new Error('Research command conflict'); return; }
      this.account(parsed.accountId);
      const previous = this.raw.prepare('SELECT COUNT(*) AS count FROM pm_account_research_jobs WHERE fingerprint=?').get(fingerprint) as { count: number };
      if (previous.count >= 3) throw new Error('Research attempt limit');
      const at = this.now();
      this.raw.prepare(`INSERT INTO pm_account_research_jobs(id,account_id,command_id,fingerprint,limits_json,state,attempt,reserved_cost_micros,cost_micros,created_at,updated_at)
        VALUES(?,?,?,?,?,'queued',0,0,NULL,?,?)`).run(z.uuid().parse(this.deps.ids.next()), parsed.accountId, parsed.commandId, fingerprint, JSON.stringify(parsed.limits), at, at);
    });
  }
  /** Observe selected durable work without claiming, parking, or settling it. */
  readSelectedResearch(input: SelectedResearch): LocalCompanyResearchStatus {
    const selected = selectedResearchSchema.parse(input);
    return this.readSnapshot(() => this.selectedResearchStatus(selected));
  }
  /** SELECT-only helper shared by the read snapshot and the owning claim transaction. */
  private selectedResearchStatus(selected: SelectedResearch): LocalCompanyResearchStatus {
    const stored = this.raw.prepare('SELECT * FROM pm_account_research_jobs WHERE command_id=?').get(selected.commandId) as Record<string, unknown> | undefined;
    // Detect command/account conflict before any mutation, even when capability is absent.
    if (stored && stored.account_id !== selected.accountId) throw new Error('Research command account conflict');
    this.account(selected.accountId);
    if (!stored) return localCompanyResearchStatusSchema.parse({ ...selected, state: 'not_recorded', receipt: null, reason: null });
    const row = z.strictObject({
      id: z.uuid(), command_id: z.uuid(), account_id: accountIdSchema,
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/), limits_json: z.string(),
      state: z.enum(['queued', 'running', 'completed', 'parked']),
      attempt: z.number().int().min(0).max(3), claim_token: z.uuid().nullable(),
      reserved_cost_micros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      cost_micros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
      receipt_command_id: z.uuid().nullable(), created_at: accountInstantSchema, updated_at: accountInstantSchema,
    }).parse(stored);
    const limits = researchLimitsSchema.parse(JSON.parse(row.limits_json));
    if (row.command_id !== selected.commandId || row.fingerprint !== accountFingerprint({ accountId: selected.accountId, limits })
      || (row.cost_micros !== null && row.cost_micros > row.reserved_cost_micros)
      || (row.state === 'queued'
        ? row.attempt !== 0 || row.claim_token !== null || row.reserved_cost_micros !== 0 || row.cost_micros !== null || row.receipt_command_id !== null
        : row.attempt === 0 || row.claim_token === null || row.reserved_cost_micros !== limits.maxCostMicros)) {
      throw new Error('Invalid selected research job');
    }
    let receipt: AccountEvidenceReceipt | null = null;
    if (row.receipt_command_id !== null) {
      if (row.receipt_command_id !== row.id || (row.state !== 'running' && row.state !== 'completed')) {
        throw new Error('Invalid selected research receipt identity');
      }
      const command = this.raw.prepare('SELECT account_id,account_version,result_json FROM pm_account_commands WHERE command_id=? AND account_id=?')
        .get(row.receipt_command_id, selected.accountId) as { account_id: string; account_version: number; result_json: string } | undefined;
      if (!command) throw new Error('Research evidence receipt required');
      receipt = accountEvidenceReceiptSchema.parse(JSON.parse(command.result_json));
      // The receipt records its historical command version, not today's mutable account version.
      if (command.account_id !== selected.accountId || receipt.accountId !== selected.accountId || receipt.version !== command.account_version) {
        throw new Error('Invalid selected research receipt account or version');
      }
    } else if (row.state === 'completed') {
      throw new Error('Research evidence receipt required');
    }
    return localCompanyResearchStatusSchema.parse({ ...selected, state: receipt ? 'completed' : row.state, receipt, reason: null });
  }
  claimSelected(asOf: string, input: SelectedResearch): ResearchJob | null {
    return this.claimResearch(asOf, selectedResearchSchema.parse(input));
  }
  claimNext(asOf: string): ResearchJob | null {
    return this.claimResearch(asOf);
  }
  private claimResearch(asOf: string, selected?: SelectedResearch): ResearchJob | null {
    accountInstantSchema.parse(asOf);
    return this.atomic(() => {
      if (selected) this.selectedResearchStatus(selected);
      const scope = selected ? ' AND j.command_id=? AND j.account_id=?' : '';
      const updateScope = selected ? ' AND command_id=? AND account_id=?' : '';
      const scopeArgs = selected ? [selected.commandId, selected.accountId] : [];
      type Row = { id: string; account_id: string; limits_json: string; attempt: number; cost_micros: number | null; fingerprint: string };
      // id is the reserved evidence command identity. A committed receipt is
      // recovered even when budget was disabled after the request.
      const receipt = this.raw.prepare(`SELECT j.* FROM pm_account_research_jobs j JOIN pm_account_commands c ON c.command_id=j.receipt_command_id AND c.account_id=j.account_id
        WHERE j.state='running'${scope} ORDER BY j.created_at,j.id LIMIT 1`).get(...scopeArgs) as Row | undefined;
      const token = () => z.uuid().parse(this.deps.ids.next());
      const result = (row: Row, claimToken: string, receiptCommitted: boolean): ResearchJob => ({ id: row.id, accountId: row.account_id,
        limits: researchLimitsSchema.parse(JSON.parse(row.limits_json)), attempt: row.attempt, claimToken,
        receiptCommandId: row.id, receiptCommitted, costMicros: row.cost_micros });
      if (receipt) {
        const claimToken = token();
        this.raw.prepare('UPDATE pm_account_research_jobs SET claim_token=?,updated_at=? WHERE id=?').run(claimToken, asOf, receipt.id);
        return result(receipt, claimToken, true);
      }
      const config = this.deps.research;
      if (!config || !Number.isSafeInteger(config.maxBudgetMicros) || config.maxBudgetMicros <= 0) return null;
      const lease = config.leaseMs ?? 300000;
      if (!Number.isSafeInteger(lease) || lease < 60000) throw new Error('Research lease invalid');
      const expired = new Date(Date.parse(asOf) - lease).toISOString();
      // Never repeat an ambiguous external request. Its unknown cost remains reserved.
      this.raw.prepare(`UPDATE pm_account_research_jobs SET state='parked',updated_at=? WHERE state='running' AND updated_at<=?${updateScope}`).run(asOf, expired, ...scopeArgs);
      const spent = this.raw.prepare('SELECT COALESCE(SUM(COALESCE(cost_micros,reserved_cost_micros)),0) AS total FROM pm_account_research_jobs').get() as { total: number };
      // Select the oldest eligible job, not just the oldest job. Expensive or
      // exhausted work stays queued without releasing any uncertain reservation.
      const row = this.raw.prepare(`SELECT j.* FROM pm_account_research_jobs j WHERE j.state='queued'
        AND json_extract(j.limits_json,'$.maxCostMicros')<=?
        AND (SELECT COUNT(*) FROM pm_account_research_jobs prior WHERE prior.fingerprint=j.fingerprint AND prior.attempt>0)<3${scope}
        ORDER BY j.created_at,j.id LIMIT 1`).get(config.maxBudgetMicros - spent.total, ...scopeArgs) as Row | undefined;
      if (!row) return null;
      const limits = researchLimitsSchema.parse(JSON.parse(row.limits_json));
      if (spent.total + limits.maxCostMicros > config.maxBudgetMicros) return null;
      const previous = this.raw.prepare('SELECT COALESCE(SUM(attempt>0),0) AS count FROM pm_account_research_jobs WHERE fingerprint=?').get(row.fingerprint) as { count: number };
      if (previous.count >= 3) return null;
      const claimToken = token(); row.attempt = previous.count + 1;
      this.raw.prepare("UPDATE pm_account_research_jobs SET state='running',attempt=?,claim_token=?,reserved_cost_micros=?,updated_at=? WHERE id=?")
        .run(row.attempt, claimToken, limits.maxCostMicros, asOf, row.id);
      return result(row, claimToken, false);
    });
  }
  settle(input: Parameters<AccountResearchStore['settle']>[0]): void {
    const parsed = z.strictObject({ jobId: z.uuid(), claimToken: z.uuid(), status: z.enum(['completed', 'parked']),
      receiptCommandId: z.uuid().nullable(), costMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).safeParse(input);
    if (!parsed.success) throw new Error('Research claim settlement invalid');
    const value = parsed.data;
    this.atomic(() => {
      const row = this.raw.prepare('SELECT account_id,state,claim_token,reserved_cost_micros,receipt_command_id,cost_micros FROM pm_account_research_jobs WHERE id=?').get(value.jobId) as {
        account_id: string; state: string; claim_token: string; reserved_cost_micros: number; receipt_command_id: string | null; cost_micros: number | null;
      } | undefined;
      if (!row || row.claim_token !== value.claimToken) throw new Error('Research claim fenced');
      if (row.state !== 'running') {
        if (row.state === value.status && row.receipt_command_id === value.receiptCommandId && row.cost_micros === value.costMicros) return;
        throw new Error('Research claim already settled');
      }
      const receipt = row.receipt_command_id === value.jobId && this.raw.prepare('SELECT 1 FROM pm_account_commands WHERE command_id=? AND account_id=?').get(value.jobId, row.account_id);
      if (value.status === 'completed' && (value.receiptCommandId !== value.jobId || !receipt)) throw new Error('Research evidence receipt required');
      if (value.status === 'parked' && (value.receiptCommandId !== null || receipt)) throw new Error('Research committed receipt requires completion');
      if (value.costMicros !== null && value.costMicros > row.reserved_cost_micros) throw new Error('Research cost exceeds reservation');
      this.raw.prepare('UPDATE pm_account_research_jobs SET state=?,receipt_command_id=?,cost_micros=?,updated_at=? WHERE id=? AND claim_token=?')
        .run(value.status, value.receiptCommandId, value.costMicros, this.now(), value.jobId, value.claimToken);
    });
  }
  listCandidates(): Account[] {
    return this.raw.prepare('SELECT id,name,domain,version FROM pm_accounts ORDER BY id COLLATE BINARY').all().map(row => accountSchema.parse(row));
  }
}
