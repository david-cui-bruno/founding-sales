import { z } from 'zod';
import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';
import { accountClaimSchema, accountCreateSchema, accountEvidenceBatchSchema, accountIdSchema, accountInstantSchema,
  accountLinkSchema, accountLinksCommandSchema, accountRouteSchema, accountSchema,
  type Account, type AccountEvidenceBatch, type AccountEvidenceReceipt, type AccountEvidenceSnapshot, type AccountLink, type AccountSource } from '../../../shared/contracts/accountContract';
import { accountFingerprint, projectAccountEvidence } from './accountEvidence';

/** Main-process composition capability. B2 must attest fetched receipts out-of-band,
 * not echo the model's permitted flag. Unconfigured admission fails closed. */
export interface AccountSourcePolicy { attest(source: Readonly<AccountSource>, accountId: string): boolean; }
type Dependencies = { database: AppDatabase; clock: Clock; ids: IdGenerator; sourcePolicy?: AccountSourcePolicy };
type Command = { commandId: string; accountId: string; expectedVersion: number };
type ReceiptRow = { fingerprint: string; result_json: string };

export class AccountRepository {
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
      const at = this.now();
      const account = accountSchema.parse({ id: this.deps.ids.next(), name: parsed.name, domain: parsed.domain, version: 1 });
      this.raw.prepare('INSERT INTO pm_accounts(id,name,domain,version,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(account.id, account.name, account.domain, at, at);
      this.record(parsed.commandId, account.id, fingerprint, account, 1, at);
      return account;
    });
  }
  private mutate(command: Command, kind: string, input: unknown, apply: (at: string) => void): AccountEvidenceReceipt {
    const fingerprint = accountFingerprint({ kind, input });
    return this.atomic(() => {
      const replay = this.replay(command.commandId, fingerprint);
      if (replay !== undefined) return { ...z.strictObject({ accountId: accountIdSchema, version: z.number().int().positive(), duplicate: z.boolean() }).parse(replay), duplicate: true };
      const current = this.account(command.accountId);
      if (current.version !== command.expectedVersion) throw new Error('Stale account version');
      const at = this.now();
      apply(at);
      const result = { accountId: current.id, version: current.version + 1, duplicate: false };
      const updated = this.raw.prepare('UPDATE pm_accounts SET version=?,updated_at=? WHERE id=? AND version=?')
        .run(result.version, at, current.id, command.expectedVersion);
      if (updated.changes !== 1) throw new Error('Stale account version');
      this.record(command.commandId, current.id, fingerprint, result, result.version, at);
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
  admitEvidence(input: AccountEvidenceBatch): AccountEvidenceReceipt {
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
    });
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
  listCandidates(): Account[] {
    return this.raw.prepare('SELECT id,name,domain,version FROM pm_accounts ORDER BY id COLLATE BINARY').all().map(row => accountSchema.parse(row));
  }
}
