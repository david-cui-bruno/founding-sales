import type {SessionQueryable} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {readResearchSettings} from '../research/settings.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import type {DiscoveryRegion,OrganizationDiscoveryProvider} from './discoveryProvider.ts';

export interface ApolloBinding {readonly accountRef:string;readonly keyRef:string}
export interface ApolloDiscoveryDependencies extends ApolloBinding {readonly provider:OrganizationDiscoveryProvider}
export const APOLLO_FREE_CYCLE_LIMIT=75;
export const validApolloReference=(value:string):boolean=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(value);
/** Configuration and dispatch must use the same account-wide lock, across workspaces.
 * Never lock an allowance row before this advisory lock.
 */
export async function lockApolloAccount(db:SessionQueryable,accountRef:string):Promise<void>{
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('apollo-free-account:'||$1,0))",[accountRef]);
}
export async function apolloAllowed(ctx:RepositoryContext):Promise<boolean>{
 return decideAdminOnly(ctx).permitted&&(await readResearchSettings(ctx)).enabled&&(await listApplicableHolds(ctx,{actionKind:'research',channel:'research'})).length===0;
}
export interface ApolloReservation {readonly id:string;readonly allowanceId:string;readonly region:DiscoveryRegion;readonly page:number}
/** Caller owns a short transaction. A committed reservation is spent even if the
 * process dies before network dispatch. DB clock is sampled AFTER both locks.
 */
export async function reserveApolloPage(ctx:RepositoryContext,binding:ApolloBinding):Promise<ApolloReservation|null>{
 if(!validApolloReference(binding.accountRef)||!validApolloReference(binding.keyRef)||!await apolloAllowed(ctx))return null;
 const db=ctx.db as SessionQueryable;
 await lockApolloAccount(db,binding.accountRef);
 const allowance=(await db.query<{id:string;workspace_id:string;key_ref:string;valid:boolean;halted:boolean;enabled:boolean;remaining:number}>(`SELECT id,workspace_id,key_ref,halted,enabled,75-starting_used-reserved AS remaining,
 cycle_start<=clock_timestamp() AND clock_timestamp()<cycle_end AND verified_at<=clock_timestamp() AND exclusive_attested_at<=clock_timestamp() AND verified_at>=cycle_start AND exclusive_attested_at>=cycle_start AND next_run_at<=clock_timestamp() AS valid
 FROM sourcing_apollo_allowances WHERE account_ref=$1 ORDER BY cycle_start DESC LIMIT 1 FOR UPDATE`,[binding.accountRef])).rows[0];
 if(!allowance||allowance.workspace_id!==ctx.scope.workspaceId||allowance.key_ref!==binding.keyRef)return null;
 // Do not use transaction-start now(): a waiter might cross the cycle boundary.
 const current=(await db.query<{valid:boolean}>(`SELECT cycle_start<=clock_timestamp() AND clock_timestamp()<cycle_end AND verified_at<=clock_timestamp() AND exclusive_attested_at<=clock_timestamp() AND next_run_at<=clock_timestamp() AS valid FROM sourcing_apollo_allowances WHERE id=$1`,[allowance.id])).rows[0]!;
 const pending=(await db.query<{id:string;expired:boolean}>(`SELECT a.id,a.reserved_at<clock_timestamp()-interval '2 minutes' AS expired FROM sourcing_apollo_attempts a JOIN sourcing_apollo_allowances l ON l.id=a.allowance_id WHERE l.account_ref=$1 AND a.state IN ('reserved','unknown') ORDER BY a.reserved_at LIMIT 1 FOR UPDATE OF a`,[binding.accountRef])).rows[0];
 if(pending){
  if(pending.expired){
   await db.query("UPDATE sourcing_apollo_attempts SET state='unknown',failure_code='dispatch_unknown' WHERE id=$1 AND state='reserved'",[pending.id]);
   await db.query('UPDATE sourcing_apollo_allowances SET halted=true WHERE account_ref=$1',[binding.accountRef]);
  }
  return null;
 }
 if(!current.valid||!allowance.enabled||allowance.halted||allowance.remaining<=0||!await apolloAllowed(ctx))return null;
 const last=(await db.query<{region:DiscoveryRegion;page:number;returned_count:number}>(`SELECT region,page,returned_count FROM sourcing_apollo_attempts WHERE allowance_id=$1 AND state='complete' ORDER BY reserved_at DESC,id DESC LIMIT 1`,[allowance.id])).rows[0];
 const regions:readonly DiscoveryRegion[]=['TX','RI','MA'];
 const region=last?(last.returned_count===100?last.region:regions[regions.indexOf(last.region)+1]):'TX';
 if(!region)return null;
 const page=last&&last.region===region?last.page+1:1;
 const attempt=(await db.query<{id:string}>(`INSERT INTO sourcing_apollo_attempts(workspace_id,allowance_id,region,page,reserved_at) VALUES($1,$2,$3,$4,clock_timestamp()) ON CONFLICT(allowance_id,region,page) DO NOTHING RETURNING id`,[ctx.scope.workspaceId,allowance.id,region,page])).rows[0];
 if(!attempt)return null;
 await db.query("UPDATE sourcing_apollo_allowances SET reserved=reserved+1,next_run_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[allowance.id]);
 return {id:attempt.id,allowanceId:allowance.id,region,page};
}
