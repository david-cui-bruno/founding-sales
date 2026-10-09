import {readBackfillCopyCoverage} from './crmBackfillCoverage.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { activeBusinessActor, businessAccountBinding } from '../business/acquisition.ts';

interface ImportRow extends Record<string, unknown> {
  connection_state:'current'|'disconnected'|'changed';id: string; state: string; reason: string | null; generation: number;
  from_at: Date; to_at: Date; history_anchor: string | null; history_complete: boolean;
  completed_slices: string; reserved_units:string; observed_units:string; unknown_units:string; metadata_counts:{retainedUniqueMessages:string;availableMetadataMessages:string;refusedMetadataMessages:string;confirmedMissingMessages:string;deletedMetadataMessages:string};
}
const health = (row: ImportRow) => ({
  connectionState:row.connection_state,importId: row.id, state: row.state, reason: row.reason, generation: row.generation,
  fromAt: row.from_at.toISOString(), toAt: row.to_at.toISOString(),
  historyAnchor: row.history_anchor, windowFrozen:row.history_anchor!==null, historyComplete: row.history_complete,
  metadataCoverage:row.metadata_counts,
  quotaAccounting:{scope:'callie_backfill_allocation' as const,reservedUnits:row.reserved_units,observedUnits:row.observed_units,unknownUnits:row.unknown_units},
  coverageKind: 'enumeration' as const, bodyCoverage: 'measured' as const, totalSlices: 90, completedSlices: Number(row.completed_slices),
});
/** The operational sync watermark is not CRM import completion. No original bytes are read. */
export async function readCrmMailImport(context: RepositoryContext, input: { mailboxId: string }) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !await activeBusinessActor(context)) return null;
  const row = (await context.db.query<ImportRow>(`
    SELECT i.*,CASE WHEN m.status<>'connected' THEN 'disconnected'
     WHEN m.generation<>i.generation OR m.provider_account_id IS DISTINCT FROM i.provider_account_id
     OR NOT EXISTS(SELECT 1 FROM crm_mail_capture_controls c JOIN crm_business_policies p ON p.workspace_id=c.workspace_id AND p.mailbox_id=c.mailbox_id WHERE c.workspace_id=i.workspace_id AND c.mailbox_id=i.mailbox_id AND c.owner_user_id=i.owner_user_id AND p.owner_user_id=i.owner_user_id AND c.provider_account_id=i.provider_account_id AND p.provider_account_id=i.provider_account_id AND c.account_binding=i.account_binding AND p.account_binding=i.account_binding AND c.generation=i.generation AND p.generation=i.generation AND c.revision=i.controls_revision AND c.policy_revision=i.policy_revision AND p.revision=i.policy_revision AND c.enabled AND p.enabled) THEN 'changed' ELSE 'current' END AS connection_state,
     (SELECT count(*) FROM crm_mail_import_slices x
      WHERE x.workspace_id=i.workspace_id AND x.import_id=i.id AND x.state='complete')::text AS completed_slices,
      (SELECT COALESCE(sum(q.units),0)::text FROM crm_mail_import_read_reservations q WHERE q.workspace_id=i.workspace_id AND q.import_id=i.id) AS reserved_units,
      (SELECT COALESCE(sum(q.units),0)::text FROM crm_mail_import_read_reservations q WHERE q.workspace_id=i.workspace_id AND q.import_id=i.id AND q.state='observed') AS observed_units,
      (SELECT COALESCE(sum(q.units),0)::text FROM crm_mail_import_read_reservations q WHERE q.workspace_id=i.workspace_id AND q.import_id=i.id AND q.state='unknown') AS unknown_units,
      (SELECT json_build_object('retainedUniqueMessages',count(*)::text,'availableMetadataMessages',count(*) FILTER(WHERE x.state='available')::text,'refusedMetadataMessages',count(*) FILTER(WHERE x.state='refused')::text,'confirmedMissingMessages',count(*) FILTER(WHERE x.state='confirmed_missing')::text,'deletedMetadataMessages',count(*) FILTER(WHERE x.state='deleted')::text) FROM crm_mail_import_messages x WHERE x.workspace_id=i.workspace_id AND x.import_id=i.id) AS metadata_counts
    FROM crm_mail_imports i JOIN mailboxes m ON m.workspace_id=i.workspace_id AND m.id=i.mailbox_id
    WHERE i.workspace_id=$1 AND i.mailbox_id=$2 AND i.owner_user_id=$3 AND m.owner_user_id=$3
    ORDER BY i.observed_at DESC,i.id DESC LIMIT 1`, [context.scope.workspaceId, input.mailboxId, actor.userId])).rows[0];
  if(row===undefined)return null;
  const copyCoverage=await readBackfillCopyCoverage(context,row.id,row.metadata_counts.retainedUniqueMessages);
  return {...health(row),copyCoverage};
}
/** Caller owns the command transaction. This persists scope, never enables capture. */
export async function requestCrmMailImport(context: RepositoryContext, input: { mailboxId: string }) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !await activeBusinessActor(context))
    return { ok: false as const, reason: 'source_access_denied' };
  const mailbox = (await context.db.query<{
    id: string; owner_user_id: string; email_address: string; provider_account_id: string | null;
    generation: number; status: string;
  }>('SELECT id,owner_user_id,email_address,provider_account_id,generation,status FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE', [context.scope.workspaceId, input.mailboxId])).rows[0];
  if (mailbox === undefined || mailbox.owner_user_id !== actor.userId || mailbox.status !== 'connected')
    return { ok: false as const, reason: 'source_access_denied' };
  const binding = businessAccountBinding(context.scope.workspaceId, mailbox);
  if (binding === null || mailbox.provider_account_id === null)
    return { ok: false as const, reason: 'capture_authority_unavailable' };
  const controls = (await context.db.query<{ revision: number; policy_revision: number }>(`
    SELECT revision,policy_revision FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2
      AND owner_user_id=$3 AND provider_account_id=$4 AND account_binding=$5 AND generation=$6 AND enabled FOR UPDATE`,
  [context.scope.workspaceId,mailbox.id,actor.userId,mailbox.provider_account_id,binding,mailbox.generation])).rows[0];
  if (controls === undefined) return { ok: false as const, reason: 'capture_authority_unavailable' };
  const policy = await context.db.query(`SELECT 1 FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2
    AND owner_user_id=$3 AND provider_account_id=$4 AND account_binding=$5 AND generation=$6 AND revision=$7 AND enabled FOR SHARE`,
  [context.scope.workspaceId,mailbox.id,actor.userId,mailbox.provider_account_id,binding,mailbox.generation,controls.policy_revision]);
  if (!policy.rows.length || !await activeBusinessActor(context))
    return { ok: false as const, reason: 'capture_authority_unavailable' };
  const imported = (await context.db.query<{id:string}>(`
    WITH instant AS (SELECT date_trunc('second',clock_timestamp()) AS at)
    INSERT INTO crm_mail_imports(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,
      controls_revision,policy_revision,from_at,to_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,at-interval '90 days',at FROM instant
    ON CONFLICT(workspace_id,mailbox_id,account_binding,generation,controls_revision,policy_revision)
    DO UPDATE SET observed_at=crm_mail_imports.observed_at RETURNING id`,
  [context.scope.workspaceId,mailbox.id,actor.userId,mailbox.provider_account_id,binding,mailbox.generation,controls.revision,controls.policy_revision])).rows[0]!;
  await context.db.query(`INSERT INTO crm_mail_import_slices(workspace_id,import_id,ordinal,from_epoch_seconds,to_epoch_seconds)
    SELECT i.workspace_id,i.id,n,extract(epoch FROM i.from_at)::bigint+n*86400,
      extract(epoch FROM i.from_at)::bigint+(n+1)*86400 FROM crm_mail_imports i CROSS JOIN generate_series(0,89) n
    WHERE i.workspace_id=$1 AND i.id=$2 ON CONFLICT DO NOTHING`,[context.scope.workspaceId,imported.id]);
  await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.mail_backfill',idempotencyKey:`crm-mail-backfill:${imported.id}`,payload:{importId:imported.id,accountBinding:binding,generation:mailbox.generation,controlsRevision:controls.revision,policyRevision:controls.policy_revision}});
  return { ok: true as const, value: {importId:imported.id,status:'queued' as const} };
}
