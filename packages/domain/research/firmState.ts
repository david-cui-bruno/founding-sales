import type { RepositoryContext } from '../db/workspaceScope.ts';
import { listApplicableHolds } from '../policy/holds.ts';
import { isSuppressed } from '../suppression/effective.ts';
import { refuse, type ResearchResult } from './types.ts';
import {retainedFirmOnly} from '../sourcing/retainedAcquisition.ts';

/**
 * Whether research may look at this firm at all.
 *
 * Four questions, asked in this order and before any clearance is claimed or any
 * provider is reached:
 *
 *   * the firm exists in this workspace;
 *   * it is not `merged` — the record is history, and re-reading a merged firm's site
 *     would write evidence onto a row nobody works;
 *   * no active firm-wide do-not-contact covers it. 10.2 makes that suppression
 *     effective immediately and database-enforced, and re-reading the site of a firm
 *     that has asked to be left alone is exactly the thing it exists to prevent —
 *     even though research never contacts anybody, because what it produces is a card
 *     that invites somebody to;
 *   * no applicable research hold covers the workspace, firm, current assigned owner
 *     or research channel. The requester is not the firm's owner authority.
 */

export interface ResearchableFirm {
  readonly firmId: string;
  readonly name: string;
  readonly website: string | null;
}

interface FirmStateRow {
  readonly id: string;
  readonly name: string;
  readonly website: string | null;
  readonly status: string;
  readonly assigned_user_id: string | null;
  readonly [column: string]: unknown;
}

export async function firmIsResearchable(
  context: RepositoryContext,
  firmId: string,
): Promise<ResearchResult<ResearchableFirm>> {
  const { rows } = await context.db.query<FirmStateRow>(
    'SELECT id, name, website, status, assigned_user_id FROM firms WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, firmId],
  );
  const firm = rows[0];
  if (firm === undefined) return refuse('firm_unknown');
  if (firm.status === 'merged') return refuse('firm_merged');
  if (await retainedFirmOnly(context,firmId)) return refuse('research_disabled');
  const suppression = await isSuppressed(context, { scope: 'firm', canonicalKey: firmId });
  if (suppression !== null) return refuse('firm_suppressed');
  const holds = await listApplicableHolds(context, {
    actionKind: 'research', firmId, channel: 'research',
    ...(firm.assigned_user_id === null ? {} : { ownerUserId: firm.assigned_user_id }),
  });
  if (holds.length > 0) return refuse('research_disabled');
  return { ok: true, value: { firmId: firm.id, name: firm.name, website: firm.website } };
}

/** True when an active firm-wide suppression covers the firm. For `judgments.ts`. */
export async function firmIsSuppressed(context: RepositoryContext, firmId: string): Promise<boolean> {
  return (await isSuppressed(context, { scope: 'firm', canonicalKey: firmId })) !== null;
}
