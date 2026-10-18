import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold } from '../policy/holds.ts';
import { applyManualModeStop } from '../sequences/terminalStops.ts';
import { recordCrmAuditEvent } from './audit.ts';
import type { ManualLedgerRow } from './linkedinManualAccess.ts';

/** Called under the exclusive send gate. Corrections NEVER delete/release this fact. */
export async function stopLinkedinManualFollowup(ctx: RepositoryContext, ledger: ManualLedgerRow, entryId: string, revision: number) {
  // Include historical/uncertain relationships and operational bridges conservatively.
  // No inaccessible firm/name content is returned to the recorder.
  const firms = (await ctx.db.query<{ firm_id: string }>(`SELECT $3::uuid AS firm_id
    UNION SELECT firm_id FROM crm_relationships WHERE workspace_id=$1 AND person_id=$2
    UNION SELECT c.firm_id FROM crm_legacy_contact_people b JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id WHERE b.workspace_id=$1 AND b.person_id=$2
    UNION SELECT firm_id FROM linkedin_manual_ledgers WHERE workspace_id=$1 AND person_id=$2
    ORDER BY firm_id`, [ctx.scope.workspaceId, ledger.person_id, ledger.firm_id])).rows;
  for (const { firm_id: firmId } of firms) {
    if ((await ctx.db.query('SELECT 1 FROM linkedin_manual_stops WHERE workspace_id=$1 AND person_id=$2 AND firm_id=$3', [ctx.scope.workspaceId, ledger.person_id, firmId])).rows.length) continue;
    const holdId = await openHold(ctx, {
      scopeKind: 'firm', scopeKey: firmId, reasonCode: 'opportunity_manual',
      blockedActionKinds: ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance'],
      sourceEventKind: 'linkedin.manual_stop', sourceEventId: entryId, ownerUserId: ledger.owner_user_id,
    });
    await applyManualModeStop(ctx, { firmId, origin: 'human_reply', cause: 'linkedin.manual_stop' });
    await ctx.db.query(`INSERT INTO linkedin_manual_stops(workspace_id,person_id,firm_id,entry_id,entry_revision,hold_id) VALUES($1,$2,$3,$4,$5,$6)`, [ctx.scope.workspaceId, ledger.person_id, firmId, entryId, revision, holdId]);
  }
  await recordCrmAuditEvent(ctx, { action: 'linkedin.manual_handoff', subjectKind: 'person', subjectId: ledger.person_id, detail: { entryId, revision, source: 'owner_assertion', resumePermitted: false } });
}
