import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
import {MANUAL_PROSPECT_ROWS_SQL} from './manualProspectRows.ts';
import {projectManualProspect,type ManualProspectRow} from './manualProspectProjection.ts';
/** Navigational dedup never changes a candidate's independent source rights. */
export const MANUAL_ACTIVITY_RAW_SQL=MANUAL_PROSPECT_ROWS_SQL.replace('duplicate_rank=1 AND ','');
export class ManualActivityAuthorityChanged extends Error{}
export class ManualActivityUnavailable extends Error{
 constructor(readonly reason:'candidate_unavailable'|'candidate_changed'){super(reason);}
}
export type ManualActivityAuthority=()=>Promise<boolean>;
export async function requireManualActivityAuthority(ctx:RepositoryContext,authority:ManualActivityAuthority):Promise<void>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin'||!await authority()||!await activeIdentityActor(ctx))throw new ManualActivityAuthorityChanged();
}
export async function manualActivityRaw(ctx:RepositoryContext,candidateId:string,revision:number):Promise<boolean>{
 const row=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_ACTIVITY_RAW_SQL}) permitted WHERE id=$3 AND revision=$4`,[ctx.scope.workspaceId,'all',candidateId,revision])).rows[0];
 return !!row&&projectManualProspect(row)!==null;
}
/** Caller owns transaction. Lock source, candidate, then activity before authority. */
export async function lockManualActivityCandidate(ctx:RepositoryContext,candidateId:string,revision:number):Promise<void>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin'||!await activeIdentityActor(ctx))throw new ManualActivityAuthorityChanged();
 await lockDiscoveryReviewSources(ctx);
 const c=(await ctx.db.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,candidateId])).rows[0];
 if(!c)throw new ManualActivityUnavailable('candidate_unavailable');
 if(c.revision!==revision)throw new ManualActivityUnavailable('candidate_changed');
}
export async function currentManualActivityAuthority(ctx:RepositoryContext,candidateId:string,revision:number,authority:ManualActivityAuthority):Promise<void>{
 if(ctx.scope.actor.kind==='user')await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,ctx.scope.actor.userId]);
 await requireManualActivityAuthority(ctx,authority);
 // Fresh wall-clock rights are read after every possible authority wait.
 if(!await manualActivityRaw(ctx,candidateId,revision))throw new ManualActivityUnavailable('candidate_unavailable');
}
