import type {RepositoryContext} from '../db/workspaceScope.ts';
import {effectiveSendingEnabled} from '../settings/effective.ts';
import type {CampaignOpeningDispatchAuthority} from './campaignOpeningModelPort.ts';

/** One statement pairs current owner consent with the clock/date it authorizes.
 * No await after the owner read can silently move the request across a stop/date. */
export async function readCampaignOpeningDispatchAuthority(ctx:RepositoryContext):Promise<CampaignOpeningDispatchAuthority|null>{
 const row=(await ctx.db.query<{at:Date;business_time_zone:string;value:unknown}>(`SELECT clock_timestamp() AS at,w.business_time_zone,
  (SELECT s.value FROM workspace_settings s WHERE s.workspace_id=w.id AND s.setting_key='sending_enabled'
   AND s.superseded_at IS NULL) AS value FROM workspaces w WHERE w.id=$1`,[ctx.scope.workspaceId])).rows[0];
 if(!row||!(row.at instanceof Date)||!Number.isFinite(row.at.getTime()))return null;
 return {authorized:effectiveSendingEnabled(true,row.value),at:row.at.toISOString(),businessTimeZone:row.business_time_zone};
}
