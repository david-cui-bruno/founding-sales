import { z } from 'zod';
import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';
import { accountInstantSchema, accountSchema } from '../../../shared/contracts/accountContract';
import { companyDraftOpenReply, companyDraftSaveReply, companyDraftMutationReceiptSchema, companyDraftMutationResultSchema, companyDraftReadSchema, getCompanyDraftSchema,
  localCompanyDraftSchema, openCompanyDraftSchema, saveCompanyDraftSchema, type CompanyDraftRead, type GetCompanyDraft,
  type LocalCompanyDraft, type OpenCompanyDraft, type SaveCompanyDraft } from '../../../shared/contracts/localCompanyDraftContract';
import { AccountRepository } from './accountRepository';
import { accountFingerprint } from './accountEvidence';
type Dependencies = { database: AppDatabase; clock: Clock; ids: IdGenerator };
type DraftRow = { id: string; account_id: string; route_id: string; route_version: number; email: string; kind: string; status: string;
  account_version_at_open: number; company_label: string; source_ids_json: string; publication_json: string; subject: string; body: string;
  revision: number; created_at: string; updated_at: string };
export class LocalCompanyDraftRepository {
  constructor(private readonly deps: Dependencies) {}
  private get raw() { return this.deps.database.raw; }
  private get accounts() { return new AccountRepository(this.deps); }
  private now() { return accountInstantSchema.parse(this.deps.clock.now()); }
  private atomic<T>(run: () => T): T {
    if (this.raw.inTransaction) throw new Error('Company draft requires its own transaction');
    return this.raw.transaction(run).immediate();
  }
  private account(accountId: string) { return accountSchema.parse(this.raw.prepare('SELECT id,name,domain,version FROM pm_accounts WHERE id=?').get(accountId)); }
  private draft(row: DraftRow): LocalCompanyDraft {
    return localCompanyDraftSchema.parse({ kind: row.kind, status: row.status, id: row.id, accountId: row.account_id, revision: row.revision,
      recipientBinding: { routeId: row.route_id, routeVersion: row.route_version, email: row.email, personId: null },
      accountVersionAtOpen: row.account_version_at_open, companyLabel: row.company_label, sourceIds: JSON.parse(row.source_ids_json),
      publication: JSON.parse(row.publication_json), subject: row.subject, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  private read(input: GetCompanyDraft): CompanyDraftRead | null {
    if (!this.raw.prepare('SELECT 1 FROM pm_accounts WHERE id=?').get(input.accountId)) return null;
    const row = this.raw.prepare(`SELECT * FROM local_company_email_drafts WHERE account_id=? AND ${'draftId' in input ? 'id=?' : 'route_id=?'}
      ORDER BY route_version DESC LIMIT 1`).get(input.accountId, 'draftId' in input ? input.draftId : input.routeId) as DraftRow | undefined;
    if (!row) return null;
    const draft = this.draft(row), accounts = this.accounts;
    let reason: CompanyDraftRead['reason'] = null;
    if (accounts.companyDraftSuppressed(draft.accountId, draft.recipientBinding.email)) reason = 'suppressed';
    else {
      const route = accounts.companyDraftRoute(draft.accountId, draft.recipientBinding.routeId);
      if (!route || route.version !== draft.recipientBinding.routeVersion || route.value.toLowerCase().trim() !== draft.recipientBinding.email
        || route.personId !== null || route.channel !== 'email' || route.purpose !== 'business' || !['published', 'confirmed'].includes(route.verification)
        || route.admittedAt > this.now()) reason = 'route_changed';
      else {
        try {
          const current = accounts.companyDraftEligibility(draft.accountId, route.id, this.now(), draft.publication);
          if (JSON.stringify(current.publication) !== JSON.stringify(draft.publication)
            || JSON.stringify(current.sourceIds) !== JSON.stringify(draft.sourceIds)) reason = 'evidence_unavailable';
        } catch { reason = 'evidence_unavailable'; }
      }
    }
    return companyDraftReadSchema.parse({ draft, stale: reason !== null, reason, editable: reason !== 'suppressed' });
  }
  get(input: GetCompanyDraft): CompanyDraftRead | null {
    const parsed = getCompanyDraftSchema.parse(input);
    return this.raw.inTransaction ? this.read(parsed) : this.raw.transaction(() => this.read(parsed)).deferred();
  }
  private replay(commandId: string, fingerprint: string) {
    const row = this.raw.prepare('SELECT account_id,draft_id,operation,fingerprint,applied_revision,receipt_json FROM local_company_draft_commands WHERE command_id=?')
      .get(commandId) as { account_id: string; draft_id: string; operation: string; fingerprint: string; applied_revision: number; receipt_json: string } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new Error('Company draft command conflict');
    const receipt = companyDraftMutationReceiptSchema.parse(JSON.parse(row.receipt_json));
    if (receipt.commandId !== commandId || receipt.accountId !== row.account_id || receipt.draftId !== row.draft_id
      || receipt.operation !== row.operation || receipt.appliedRevision !== row.applied_revision) throw new Error('Company draft receipt unavailable');
    const current = this.read({ accountId: receipt.accountId, draftId: receipt.draftId });
    return companyDraftMutationResultSchema.parse({ receipt, current });
  }
  private record(commandId: string, operation: 'open' | 'save', fingerprint: string, draft: LocalCompanyDraft) {
    const receipt = companyDraftMutationReceiptSchema.parse({ commandId, operation, accountId: draft.accountId, draftId: draft.id,
      appliedRevision: draft.revision, recipientBinding: draft.recipientBinding, publication: draft.publication });
    this.raw.prepare(`INSERT INTO local_company_draft_commands(command_id,account_id,draft_id,operation,fingerprint,applied_revision,receipt_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(commandId, draft.accountId, draft.id, operation, fingerprint, draft.revision, JSON.stringify(receipt), this.now());
    return companyDraftMutationResultSchema.parse({ receipt, current: this.read({ accountId: draft.accountId, draftId: draft.id }) });
  }
  open(input: OpenCompanyDraft) {
    const parsed = openCompanyDraftSchema.parse(input), fingerprint = accountFingerprint({ operation: 'open', ...parsed });
    return this.atomic(() => {
      const previous = this.replay(parsed.commandId, fingerprint); if (previous) return companyDraftOpenReply(parsed).parse(previous);
      const account = this.account(parsed.accountId), at = this.now();
      if (account.version !== parsed.expectedAccountVersion) throw new Error('Stale company observation');
      const eligible = this.accounts.companyDraftEligibility(account.id, parsed.routeId, at);
      if (eligible.route.version !== parsed.expectedRouteVersion) throw new Error('Stale company route');
      const existing = this.raw.prepare('SELECT * FROM local_company_email_drafts WHERE account_id=? AND route_id=? AND route_version=?')
        .get(account.id, parsed.routeId, parsed.expectedRouteVersion) as DraftRow | undefined;
      if (existing) return this.record(parsed.commandId, 'open', fingerprint, this.draft(existing));
      const draft = localCompanyDraftSchema.parse({ id: this.deps.ids.next(), kind: 'local_company_email', status: 'unsent', accountId: account.id, revision: 1,
        recipientBinding: { routeId: eligible.route.id, routeVersion: eligible.route.version, email: eligible.email, personId: null },
        accountVersionAtOpen: account.version, companyLabel: account.name, sourceIds: eligible.sourceIds, publication: eligible.publication,
        subject: '', body: '', createdAt: at, updatedAt: at });
      this.raw.prepare(`INSERT INTO local_company_email_drafts(id,account_id,route_id,route_version,email,kind,status,account_version_at_open,company_label,
        source_ids_json,publication_json,subject,body,revision,created_at,updated_at) VALUES(?,?,?,?,?,'local_company_email','unsent',?,?,?,?,?,?,1,?,?)`)
        .run(draft.id, account.id, eligible.route.id, eligible.route.version, eligible.email, account.version, account.name,
          JSON.stringify(draft.sourceIds), JSON.stringify(draft.publication), '', '', at, at);
      return this.record(parsed.commandId, 'open', fingerprint, draft);
    });
  }
  save(input: SaveCompanyDraft) {
    const parsed = saveCompanyDraftSchema.parse(input), fingerprint = accountFingerprint({ operation: 'save', ...parsed });
    return this.atomic(() => {
      const previous = this.replay(parsed.commandId, fingerprint); if (previous) return companyDraftSaveReply(parsed).parse(previous);
      const current = this.read({ accountId: parsed.accountId, draftId: parsed.draftId });
      if (!current || !current.editable || current.draft.revision !== parsed.expectedRevision) throw new Error('Company draft unavailable or revision conflict');
      const revision = z.number().int().positive().safe().parse(parsed.expectedRevision + 1);
      const at = this.now();
      const changed = this.raw.prepare('UPDATE local_company_email_drafts SET subject=?,body=?,revision=?,updated_at=? WHERE account_id=? AND id=? AND revision=?')
        .run(parsed.subject, parsed.body, revision, at, parsed.accountId, parsed.draftId, parsed.expectedRevision);
      if (changed.changes !== 1) throw new Error('Company draft revision conflict');
      return this.record(parsed.commandId, 'save', fingerprint, { ...current.draft, revision, subject: parsed.subject, body: parsed.body, updatedAt: at });
    });
  }
}
