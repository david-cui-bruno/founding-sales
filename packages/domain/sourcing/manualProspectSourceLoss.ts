import type {RepositoryContext} from '../db/workspaceScope.ts';
import {actorKind,actorUserId} from '../crm/types.ts';
import {lockPreparationCleanup} from '../calling/preparationLifecycle.ts';
import {eraseManualActivityForSources} from './manualProspectActivitySourceErasure.ts';
import {eraseProspectPhoneDiscoveriesForSources} from './prospectPhoneDiscoveryLifecycle.ts';
import {eraseCampaignOpeningsForSources} from '../outreach/campaignOpeningRetention.ts';
export const MANUAL_SOURCE_LOSS_ACTION='sourcing.manual_source_retention_expired';
/** Existing append-only audit custody, used only as a denial fence. No URL/body
 * is retained and no candidate/CRM data is changed. Absence grants no authority. */
export async function rememberExpiredManualSources(ctx:RepositoryContext,urls:readonly string[]):Promise<void>{
 if(urls.length===0)return;
 // Keep deletion's source lifecycle -> workspace send gate order.
 await lockPreparationCleanup(ctx);
 await eraseCampaignOpeningsForSources(ctx,urls);
 // Optional new owner: historical migration fixtures have no priority tables.
 if((await ctx.db.query<{exists:boolean}>("SELECT to_regclass('sourcing_prospect_priorities') IS NOT NULL AS exists")).rows[0]?.exists)
  await ctx.db.query('SELECT erase_prospect_priority_sources($1,$2::text[])',[ctx.scope.workspaceId,urls.map(url=>url.replace(/\/$/u,''))]);
 await eraseManualActivityForSources(ctx,urls);
 await eraseProspectPhoneDiscoveriesForSources(ctx,urls);
 await ctx.db.query(`INSERT INTO audit_events(workspace_id,actor_kind,actor_user_id,action,subject_kind,subject_id,detail)
 SELECT $1,$2,$3,$4,'sourcing_source_hash',source.hash,'{}'::jsonb
 FROM (SELECT DISTINCT encode(sha256(convert_to(rtrim(url,'/'),'UTF8')),'hex') AS hash FROM unnest($5::text[]) url) source
 WHERE NOT EXISTS(SELECT 1 FROM audit_events a WHERE a.workspace_id=$1 AND a.action=$4 AND a.subject_kind='sourcing_source_hash' AND a.subject_id=source.hash)`,
 [ctx.scope.workspaceId,actorKind(ctx),actorUserId(ctx),MANUAL_SOURCE_LOSS_ACTION,urls]);
}
