import type { AppDatabase } from '../../db/database';
import type { AccountEvidenceSnapshot } from '../../../shared/contracts/accountContract';
import { localAccountPreparationSchema, localAccountPreparationStepSchema, localWorkspaceSnapshotSchema,
  type LocalAccountPreparation, type LocalAccountPreparationStep, type LocalAccountSnapshot, type LocalWorkspaceSnapshot } from '../../../shared/contracts/localWorkspaceContract';

const UNKNOWN: LocalAccountPreparation = Object.freeze({ researched: null, unsentDraft: null, businessRoute: null, nextStep: 'unknown',
  reason: 'Local preparation evidence unavailable for this company. Open it to check again.' });
type ResearchRow = { completed: number; pending: number; parked: number; sources: number };

/** SELECT-only. Saved local evidence describes what the founder can prepare next. It never establishes
 *  worker ownership, never starts research, and never opens or sends a draft. A failed read stays unknown. */
export function readLocalCompanyPreparation(database: AppDatabase, snapshot: AccountEvidenceSnapshot): LocalAccountPreparation {
  try {
    const accountId = snapshot.account.id;
    const research = database.raw.prepare(`SELECT
      EXISTS(SELECT 1 FROM pm_account_research_jobs WHERE account_id=? AND state='completed') AS completed,
      EXISTS(SELECT 1 FROM pm_account_research_jobs WHERE account_id=? AND state IN ('queued','running')) AS pending,
      EXISTS(SELECT 1 FROM pm_account_research_jobs WHERE account_id=? AND state='parked') AS parked,
      EXISTS(SELECT 1 FROM pm_account_sources WHERE account_id=? AND permitted=1) AS sources`).get(accountId, accountId, accountId, accountId) as ResearchRow;
    const drafts = database.raw.prepare(`SELECT COUNT(*) AS count FROM local_company_email_drafts WHERE account_id=? AND status='unsent'`).get(accountId) as { count: number };
    const researched = research.completed === 1 || research.sources === 1;
    const unsentDraft = drafts.count > 0;
    // Same eligibility the company draft panel applies: a published or confirmed company business inbox with evidence.
    const businessRoute = snapshot.routes.some(route => route.channel === 'email' && route.personId === null && route.purpose === 'business'
      && (route.verification === 'published' || route.verification === 'confirmed') && route.evidenceIds.length > 0);
    const nextStep: LocalAccountPreparationStep = unsentDraft ? 'reopen_draft' : !researched ? 'research' : !businessRoute ? 'add_route' : 'draft';
    const reason = nextStep === 'reopen_draft'
      ? `${drafts.count === 1 ? 'An unsent local draft is' : `${drafts.count} unsent local drafts are`} saved. Reopen to review it. Saving is not sending.`
      : nextStep === 'research'
        ? research.pending === 1 ? 'A research attempt is recorded but not completed. Check its status before starting another.'
          : research.parked === 1 ? 'A research attempt was parked. Review it before starting another.'
            : 'No research or saved sources yet. Research is an explicit, potentially paid step.'
        : nextStep === 'add_route' ? 'Saved evidence has no published business inbox. Review a saved source or import a route before drafting.'
          : 'Saved evidence and a published business inbox are ready. Preparing a draft is explicit and saves locally only.';
    return localAccountPreparationSchema.parse({ researched, unsentDraft, businessRoute, nextStep, reason });
  } catch { return UNKNOWN; }
}
export const localPreparationRank = (step: LocalAccountPreparationStep) => localAccountPreparationStepSchema.options.indexOf(step);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Attach one summary per saved company and order most ready first, then by name and id. Unavailable stays unavailable. */
export function attachLocalPreparation(database: AppDatabase, snapshot: LocalWorkspaceSnapshot): LocalWorkspaceSnapshot {
  if (snapshot.accounts.state !== 'available') return snapshot;
  const assessed: (LocalAccountSnapshot & { preparation: LocalAccountPreparation })[] = snapshot.accounts.snapshots
    .map(account => ({ ...account, preparation: readLocalCompanyPreparation(database, account) }));
  assessed.sort((a, b) => localPreparationRank(a.preparation.nextStep) - localPreparationRank(b.preparation.nextStep)
    || compare(a.account.name, b.account.name) || compare(a.account.id, b.account.id));
  return localWorkspaceSnapshotSchema.parse({ ...snapshot, accounts: { state: 'available', snapshots: assessed } });
}
