import { accountRecordSchema } from '../../../../src/shared/contracts/accountRecordContract';
import { ownerCommandSchema, ownerSourceConfigurationSchema, ownerSourceKey } from '../../../../src/shared/contracts/ownerCommandContract';
import { territoryMailScopeCommandId } from '../../../../src/shared/contracts/territoryCallPolicyContract';
import { googleScopes } from './googleGrantCapabilities';
import { DynamoStore, keyPart, type RepositoryOptions } from './dynamoStore';
import { authorityRecordSchema, executionAuthorityKey } from './executionRepository';
import { OwnerCommandCoordinator } from './ownerCommandCoordinator';
import type { RemoteGoogleAuthorization } from './remoteGoogleAuthorization';
import { DynamoThreadIntakeRepository } from './threadIntakeRepository';
import { TerritoryPolicyRepository } from './territoryPolicyRepository';
import type { WorkerAuth } from './workerAuth';

/**
 * The per-firm mail scope of a firm the standing territory policy already enrolled (D13, lane 41).
 *
 * After lanes 39 and 40 every part of a cold first email exists — the approved text, the cited
 * `business_email` claim, the intent, the permission, the reservation, the walker — and every real
 * territory firm still held with `mailbox_not_connected`, truthfully: `applyTerritoryPolicy` writes an
 * enrolled firm a **no-mail** owner source and an empty intake registry, because that is all the call
 * path needs. The mail rails then refuse, correctly, because there is no mailbox for that firm, no mail
 * scope naming the recipient and no completed poll.
 *
 * This is the plumbing under a permission David already gave. A template's standing approval is his
 * permission for the worker to send that template as a sequence step from the mailbox he connected; the
 * per-firm mail scope is how that send is addressed at all. So the worker may configure it for a firm it
 * has already enrolled once the grant is ready and at least one template carries a standing approval, and
 * never before either of those. **Nothing in this file sends, drafts, approves or polls.** It issues one
 * `configure-owner` per firm and stops; the poll is the existing configurations phase's work, and the send
 * is the walker's, under the reservation and the sender cap that fence every email this system sends.
 */

/** At most this many firms are configured per scheduled tick: one owner command and one transaction each. */
export const TERRITORY_MAIL_SCOPE_TICK_LIMIT = 25;

/** Why one firm was left alone this tick. Counts only: no firm, mailbox or address enters the tick record. */
export type TerritoryMailScopeSkip = 'policy_paused' | 'no_template_approved' | 'grant_not_ready'
  | 'not_enrolled' | 'no_email_route' | 'scope_configured';
export const TERRITORY_MAIL_SCOPE_SKIPS: readonly TerritoryMailScopeSkip[] = Object.freeze([
  'policy_paused', 'no_template_approved', 'grant_not_ready', 'not_enrolled', 'no_email_route', 'scope_configured',
]);
export type TerritoryMailScopeReport = {
  /** Firms this walk looked at. */
  scanned: number;
  /** Firms that gained their mail scope on this tick. */
  configured: number;
  /** Firms whose configuration threw something unexpected. Never counted as a skip: a skip is a named condition. */
  failed: number;
  skipped: Record<TerritoryMailScopeSkip, number>;
};
export const emptyTerritoryMailScopeReport = (): TerritoryMailScopeReport => ({ scanned: 0, configured: 0, failed: 0,
  skipped: { policy_paused: 0, no_template_approved: 0, grant_not_ready: 0, not_enrolled: 0, no_email_route: 0, scope_configured: 0 } });

export type TerritoryMailScopeDependencies = {
  auth: WorkerAuth;
  authorization: RemoteGoogleAuthorization;
  options: RepositoryOptions;
};

/** The mailbox this workspace's correspondence grant actually names, or null when there is nothing to configure from. */
async function connectedMailbox(authorization: RemoteGoogleAuthorization, pairingId: string): Promise<string | null> {
  const status = await authorization.status(pairingId);
  const grant = status.grant;
  if (status.state !== 'ready' || !grant || grant.purpose !== 'permitted_correspondence' || grant.owner !== 'remote') return null;
  // `configure-owner` itself requires the read scope for a mailbox it admits a scope for, so a grant without
  // it is not ready for this and is reported as such instead of being sent into a refusal.
  return grant.grantedScopes.includes(googleScopes.relevant_read) ? grant.subject : null;
}

/**
 * The window the firm's first poll covers: the start of the UTC day the scope is configured. The scope
 * admission refuses a window older than thirty days, and a firm the worker has never written to has no
 * earlier mail of its own to find, so nothing is lost by starting today. It is also stable for the whole
 * day, which keeps a retried tick issuing the byte-identical command its own derived id already names.
 */
export function territoryMailScopeSince(now: string): string {
  const day = now.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('territory_mail_scope_instant');
  return `${day}T00:00:00.000Z`;
}

export function createTerritoryMailScopeConfigurator(input: TerritoryMailScopeDependencies) {
  const store = new DynamoStore(input.options);
  const territory = new TerritoryPolicyRepository(input.options);
  const threads = new DynamoThreadIntakeRepository(input.options);
  const coordinator = new OwnerCommandCoordinator({ auth: input.auth, authorization: input.authorization });

  /** One firm: the command it needs, or the named condition under which it is left exactly as it is. */
  async function configureFirm(accountId: string, mailboxSubject: string, pairingId: string): Promise<'configured' | TerritoryMailScopeSkip> {
    const enrolled = await territory.readEnrollmentRecord(accountId);
    if (!enrolled) return 'not_enrolled';
    // (c) A firm that already has a mail scope for this mailbox is finished with this step forever.
    const cursor = await threads.cursorState(accountId, mailboxSubject);
    if (cursor?.data.scope) return 'scope_configured';
    const sourceRow = await store.get<unknown>(ownerSourceKey(accountId));
    const source = ownerSourceConfigurationSchema.safeParse(sourceRow?.data);
    // The firm must be one this workspace's own policy configured, still active, still bound to the approving
    // pairing, and still carrying no mailbox. Anything else is somebody's explicit configuration, not this.
    if (!source.success || source.data.accountId !== accountId || source.data.workspaceId !== input.options.workspaceId
      || source.data.pairingId !== pairingId || source.data.state !== 'active'
      || source.data.mailboxSubject !== null || source.data.calendarId !== null || source.data.research !== null) return 'scope_configured';
    const recordRow = await store.get<unknown>(`ACCOUNT#${keyPart(accountId)}`);
    const record = accountRecordSchema.safeParse(recordRow?.data);
    if (!record.success || record.data.account.id !== accountId) return 'not_enrolled';
    // The route is what `configure-owner` builds the scope's participants from; a claim alone never enters it.
    const newest = record.data.routes.filter(route => route.channel === 'email' && route.accountId === accountId
      && !record.data.routes.some(later => later.id === route.id && later.version > route.version));
    if (!newest.length) return 'no_email_route';
    if (newest.some(route => route.evidenceIds.length === 0
      || route.evidenceIds.some(id => !record.data.sources.some(entry => entry.id === id && entry.permitted)))) return 'no_email_route';
    const authorityRow = await store.get<unknown>(executionAuthorityKey(accountId));
    const authority = authorityRecordSchema.safeParse(authorityRow?.data);
    if (!authority.success || authority.data.authority.accountId !== accountId || authority.data.authority.owner !== 'worker'
      || authority.data.authority.state !== 'active') return 'not_enrolled';
    const commandId = territoryMailScopeCommandId(accountId, mailboxSubject);
    // A receipt already stored under the derived id is the same command already applied: the scope either exists
    // or the firm's own cursor says why, and either way a second command is never issued for it.
    if (await store.get(`COMMAND#${keyPart(commandId)}`)) return 'scope_configured';
    const command = ownerCommandSchema.parse({ commandId, workspaceId: input.options.workspaceId, accountId,
      expectedAuthorityGeneration: authority.data.authority.generation, expectedVersion: authority.data.version,
      kind: 'configure-owner',
      payload: { expectedConfigurationRevision: source.data.revision,
        configuration: { version: 1, workspaceId: input.options.workspaceId, accountId, pairingId,
          revision: source.data.revision + 1, state: 'active', mailboxSubject, calendarId: null, research: null },
        mailScope: { expectedEnvelopeRevision: cursor?.rev ?? null, since: territoryMailScopeSince(store.now()) } } });
    const receipt = await coordinator.applyTerritoryMailScope(command, pairingId);
    return receipt.status === 'applied' ? 'configured' : 'scope_configured';
  }

  return {
    /**
     * Configure the mail scope of the firms the territory sweep already scanned this tick. Bounded by the
     * sweep's own page and by `TERRITORY_MAIL_SCOPE_TICK_LIMIT`. The three workspace-level conditions are
     * read once — an active policy, a ready correspondence grant, one standing template approval with sends
     * unpaused — and every firm is counted under the first of them that is missing, so the record says how
     * many firms are waiting and on what. Nothing here sends, polls, drafts or approves anything.
     */
    async configureDueMailScopes(accountIds: readonly string[], signal: AbortSignal): Promise<TerritoryMailScopeReport> {
      const report = emptyTerritoryMailScopeReport();
      const firms = [...new Set(accountIds)];
      if (!firms.length) return report;
      const all = (skip: TerritoryMailScopeSkip): TerritoryMailScopeReport =>
        ({ ...report, scanned: firms.length, skipped: { ...report.skipped, [skip]: firms.length } });
      const policy = await territory.read();
      if (!policy || policy.data.state !== 'active') return all('policy_paused');
      // (b) The permission this plumbing sits under: one template David approved, and sends not paused.
      const templates = await territory.readTemplateState();
      if (!templates || templates.data.paused || !templates.data.approvals.length) return all('no_template_approved');
      // (a) The grant for the workspace mailbox, live from the worker's own record.
      const mailboxSubject = await connectedMailbox(input.authorization, policy.data.pairingId);
      if (mailboxSubject === null) return all('grant_not_ready');
      for (const accountId of firms) {
        if (signal.aborted || report.configured >= TERRITORY_MAIL_SCOPE_TICK_LIMIT) return report;
        report.scanned++;
        try {
          const outcome = await configureFirm(accountId, mailboxSubject, policy.data.pairingId);
          if (outcome === 'configured') report.configured++;
          else report.skipped[outcome]++;
        } catch { report.failed++; }
      }
      return report;
    },
  };
}
