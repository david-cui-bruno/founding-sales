import type {Queryable} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockDiscoveryReviewSources} from '../sourcing/discoveryReviewVisibility.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {lockTodayForFirmChange} from '../today/build.ts';

/** Permanent marker lookup precedes any execution gate. New bindings only create
 * new Firms in the same transaction; existing unbound Firms can never gain one.
 */
export async function lockPreparedCallingLifecycle(db:Queryable,workspaceId:string,firmId:string):Promise<void>{
 if((await db.query('SELECT 1 FROM calling_preparations WHERE workspace_id=$1 AND firm_ref=$2',[workspaceId,firmId])).rows.length)
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${workspaceId}`]);
}
export async function lockPreparedCallingCapability(db:Queryable,workspaceId:string,kind:'ticket'|'session'|'handoff',id:string):Promise<void>{
 const table=kind==='ticket'?'dial_tickets':kind==='session'?'call_sessions':'phone_handoff_attempts';
 const row=(await db.query<{firm_id:string|null}>(`SELECT firm_id FROM ${table} WHERE workspace_id=$1 AND id=$2`,[workspaceId,id])).rows[0];
 if(row?.firm_id)await lockPreparedCallingLifecycle(db,workspaceId,row.firm_id);
}
/** Registered mutation owners take these before candidate/member/Firm rows. */
export async function lockPreparationCleanup(ctx:RepositoryContext):Promise<void>{
 await lockDiscoveryReviewSources(ctx);
 await lockSendGateForStopFact(ctx);
 await lockTodayForFirmChange(ctx);
}
/** Source owner already holds lifecycle; keep ordinary unbound reads read-only. */
export async function lockLivePreparationCleanup(ctx:RepositoryContext):Promise<void>{
 await lockDiscoveryReviewSources(ctx);
 // A source-loss veto can affect another candidate retaining the same source.
 // Serialize this tiny source-bound flow before the first candidate/member row.
 if((await ctx.db.query("SELECT 1 FROM calling_preparations WHERE workspace_id=$1 AND state='live' LIMIT 1",[ctx.scope.workspaceId])).rows.length){
  await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
 }
}
export async function erasePreparationForFirm(ctx:RepositoryContext,firmId:string):Promise<void>{
 const rows=(await ctx.db.query<{id:string}>("SELECT id FROM calling_preparations WHERE workspace_id=$1 AND firm_ref=$2 AND state='live' ORDER BY id",[ctx.scope.workspaceId,firmId])).rows;
 for(const row of rows)await ctx.db.query("SELECT erase_calling_preparation($1,$2,'firm_deleted')",[ctx.scope.workspaceId,row.id]);
}
/** Stable ownership is not inferred from values or state. Guard ordinary edits
 * before their route/Firm locks, which otherwise have a different existing order.
 */
export async function preparedCallingFirm(ctx:RepositoryContext,firmId:string):Promise<boolean>{
 return (await ctx.db.query('SELECT 1 FROM calling_preparations WHERE workspace_id=$1 AND firm_ref=$2',[ctx.scope.workspaceId,firmId])).rows.length>0;
}
export async function preparedCallingRoute(ctx:RepositoryContext,routeId:string):Promise<boolean>{
 return (await ctx.db.query('SELECT 1 FROM calling_preparations WHERE workspace_id=$1 AND route_ref=$2',[ctx.scope.workspaceId,routeId])).rows.length>0;
}
