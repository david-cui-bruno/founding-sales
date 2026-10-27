import type {RepositoryContext} from '../db/workspaceScope.ts';
import {sendGateLockName} from '../policy/sendGate.ts';
import {tryLockResearchBudget} from '../research/ceilings.ts';
import {settleAttempt} from '../research/reservations.ts';
/** Retained paid claims must expire even though no new automatic incoming work is created. */
export async function expireRoutineReplies(ctx:RepositoryContext,at:string):Promise<void>{
 if(!await tryLockRoutineWorkspace(ctx))return;
 const pending=(await ctx.db.query<{id:string;state:string}>(`SELECT p.id,p.state FROM provider_reservations p JOIN outreach_reply_requests r ON r.workspace_id=p.workspace_id AND r.id=p.subject_id WHERE p.workspace_id=$1 AND p.subject_kind='outreach_reply' AND p.state IN ('reserved','calling') AND r.deadline_at<=$2 ORDER BY r.deadline_at,r.id LIMIT 100`,[ctx.scope.workspaceId,at])).rows;
 for(const p of pending)await settleAttempt(ctx,{reservationId:p.id,at,outcome:{kind:p.state==='calling'?'estimated':'released'}});
 await ctx.db.query("UPDATE outreach_reply_requests SET state='expired',reason='deadline_exceeded',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND state IN ('queued','calling') AND deadline_at<=$2",[ctx.scope.workspaceId,at]);
}
export async function tryLockRoutineWorkspace(ctx:RepositoryContext):Promise<boolean>{
 const gate=(await ctx.db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[sendGateLockName(ctx.scope.workspaceId)])).rows[0]?.locked;
 return gate===true&&await tryLockResearchBudget(ctx);
}
