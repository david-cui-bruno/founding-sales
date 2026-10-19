import type { RepositoryContext } from '../db/workspaceScope.ts';

type Scope = { readonly firmId: string; readonly contactId: string | null };
interface ReceiptBinding {
  [key: string]: unknown; id: string; selfTestFirmId: string | null; selfTestE164: string | null;
  selfTestErasedAt: string | null; revokedAt: string | null; validUntil: string | null;
}
const IN_SCOPE = 'workspace_id=$1 AND firm_id=$2 AND ($3::uuid IS NULL OR contact_id=$3)';
const ATTEMPT_IN_SCOPE = `workspace_id=$1 AND ((firm_id=$2 AND ($3::uuid IS NULL OR contact_id=$3))
  OR phone_route_id IN (SELECT id FROM phone_routes WHERE ${IN_SCOPE}))`;
const RECEIPT_IN_SCOPE = `workspace_id=$1 AND self_test_erased_at IS NULL AND
  ((self_test_firm_id=$2 AND $3::uuid IS NULL) OR self_test_e164 IN
    (SELECT e164 FROM phone_routes WHERE ${IN_SCOPE} UNION SELECT e164 FROM phone_handoff_attempts WHERE ${ATTEMPT_IN_SCOPE}))`;

/** Include frozen old endpoints as well as current routes in the erasure closure. */
export async function measurePhoneHandoffDeletion(context: RepositoryContext, scope: Scope): Promise<{ attempts: number; scrubs: number; receipts: number; handles: string[]; receiptBindings: ReceiptBinding[] }> {
  const values = [context.scope.workspaceId, scope.firmId, scope.contactId];
  const handles = (await context.db.query<{ e164: string }>(`SELECT e164 FROM phone_handoff_attempts WHERE ${ATTEMPT_IN_SCOPE} AND erased_at IS NULL
    UNION SELECT e164 FROM phone_routes WHERE ${IN_SCOPE}
    UNION SELECT self_test_e164 AS e164 FROM phone_owner_risk_receipts WHERE ${RECEIPT_IN_SCOPE}`, values)).rows.map(row => row.e164);
  const attempts = (await context.db.query<{ count: string }>(`SELECT count(*) AS count FROM phone_handoff_attempts WHERE ${ATTEMPT_IN_SCOPE} AND erased_at IS NULL`, values)).rows[0];
  const scrubs = (await context.db.query<{ count: string }>('SELECT count(*) AS count FROM national_registry_endpoint_scrubs WHERE workspace_id=$1 AND e164=ANY($2::text[])',
    [context.scope.workspaceId, handles])).rows[0];
  const receiptBindings = (await context.db.query<ReceiptBinding>(`SELECT id,self_test_firm_id AS "selfTestFirmId",self_test_e164 AS "selfTestE164",
    self_test_erased_at::text AS "selfTestErasedAt",revoked_at::text AS "revokedAt",valid_until::text AS "validUntil"
    FROM phone_owner_risk_receipts WHERE ${RECEIPT_IN_SCOPE} ORDER BY id`, values)).rows;
  return { attempts: Number(attempts?.count ?? 0), scrubs: Number(scrubs?.count ?? 0), receipts: receiptBindings.length, handles, receiptBindings };
}

/** Gate and firm already held. Clear every prospect binding before route/log deletion. */
export async function erasePhoneHandoffs(context: RepositoryContext, scope: Scope): Promise<{ attempts: number; scrubs: number; receipts: number }> {
  const measured = await measurePhoneHandoffDeletion(context, scope);
  const receipts = await context.db.query(`UPDATE phone_owner_risk_receipts SET self_test_firm_id=NULL,self_test_e164=NULL,self_test_erased_at=clock_timestamp()
    WHERE ${RECEIPT_IN_SCOPE}`, [context.scope.workspaceId, scope.firmId, scope.contactId]);
  const erased = await context.db.query(`UPDATE phone_handoff_attempts SET erased_at=clock_timestamp(), e164=NULL,phone_route_id=NULL,
    route_version=NULL,contact_id=NULL,opportunity_id=NULL,item_id=NULL,registry_snapshot_id=NULL,registry_scrubbed_at=NULL,call_log_id=NULL,
    office_proof_kind=NULL,office_proof_id=NULL,office_proof_expires_at=NULL
    WHERE ${ATTEMPT_IN_SCOPE} AND erased_at IS NULL`, [context.scope.workspaceId, scope.firmId, scope.contactId]);
  const scrubs = await context.db.query('DELETE FROM national_registry_endpoint_scrubs WHERE workspace_id=$1 AND e164=ANY($2::text[])',
    [context.scope.workspaceId, measured.handles]);
  return { attempts: erased.rowCount ?? 0, scrubs: scrubs.rowCount ?? 0, receipts: receipts.rowCount ?? 0 };
}
