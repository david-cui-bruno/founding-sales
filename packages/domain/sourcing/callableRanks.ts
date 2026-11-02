import {preparedCallableRank} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SessionQueryable} from '../db/queryable.ts';
import {MANUAL_PROSPECT_ROWS_SQL} from './manualProspectRows.ts';
import type {ManualProspectRow} from './manualProspectProjection.ts';
import {contextRunSql} from './prospectPriorityStore.ts';
import {currentBriefs,type BriefReader} from './preparedProspects.ts';

const DAY=86_400_000,BATCH=50;
const worker=async(ctx:RepositoryContext)=>ctx.scope.actor.kind==='system'&&ctx.scope.actor.component==='worker';
interface Stale extends Record<string,unknown> {id:string;revision:number;run_id:string}
/** Candidates with retained first-party research and no current rank row (`at` is the SQL instant the row must outlive). */
const staleFrom=(at:string)=>`FROM sourcing_candidates c
 JOIN LATERAL(SELECT id,candidate_revision,reason,observations FROM sourcing_qualification_runs q WHERE q.workspace_id=c.workspace_id AND q.candidate_id=c.id ORDER BY requested_at DESC,id DESC LIMIT 1) r ON true
 LEFT JOIN sourcing_callable_ranks h ON h.workspace_id=c.workspace_id AND h.candidate_id=c.id
 WHERE c.status<>'dismissed' AND ${contextRunSql('c.revision')} AND NOT COALESCE(h.run_id=r.id AND h.candidate_revision=c.revision AND h.expires_at>${at},false)`;
/** Never ranked first, then the longest expired. */
const STALE_SQL=`SELECT c.id,c.revision,r.id AS run_id ${staleFrom('clock_timestamp()')} AND c.workspace_id=$1 ORDER BY h.computed_at NULLS FIRST,c.id LIMIT $2`;
export const workspacesWithStaleCallableRanks=async(db:SessionQueryable,now:string)=>
 (await db.query<{id:string}>(`SELECT w.id FROM workspaces w WHERE EXISTS(SELECT 1 ${staleFrom('$1::timestamptz')} AND c.workspace_id=w.id) ORDER BY w.id`,[now])).rows.map(row=>row.id);

/** The worker reads under its own system actor: the callable rank grants nothing, and the list re-projects every page it shows
 * under the admin principal. The lifecycle lock and every source limit are still required by the projection. */
const WORKER_READER:BriefReader={access:worker,custody:{principal:true}};
/** ADR0034: refresh the advisory Callable-today order key for up to fifty candidates, by projecting each one exactly as the
 * list does. Worker only; the row stores a rank and a host, never text. A candidate the projection cannot show (source lost,
 * not visible) gets a not-callable row so it is not retried every pass. Returns how many candidates were written.
 * The caller owns the transaction (the job runner's), so one call is one bounded batch and a lost lease rolls it back. */
export async function refreshCallableRanks(ctx:RepositoryContext):Promise<number> {
 if(!await worker(ctx))return 0;
 const stale=(await ctx.db.query<Stale>(STALE_SQL,[ctx.scope.workspaceId,BATCH])).rows;
 if(!stale.length)return 0;
 const readRows=async()=>{
  const rows=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_ROWS_SQL}) visible WHERE id=ANY($3::uuid[])`,[ctx.scope.workspaceId,'all',stale.map(s=>s.id)])).rows;
  return stale.flatMap(s=>{const row=rows.find(r=>r.id===s.id&&r.revision===s.revision);return row?[row]:[];});
 };
 const result=await currentBriefs(ctx,readRows,async()=>true,WORKER_READER);
 if(!result.ok)return 0;
 const {briefs,now}=result.value;let written=0;
 for(const s of stale){
  const brief=briefs.find(b=>b.target.candidateId===s.id&&b.target.candidateRevision===s.revision&&b.target.runId===s.run_id);
  const valid=brief?.validUntil?Date.parse(brief.validUntil):Number.POSITIVE_INFINITY;
  const usable=brief&&valid>now+60_000?brief:undefined;
  const rank=usable?.callable.state==='callable'?preparedCallableRank(usable.callable):null;
  const expires=usable?Math.min(valid,now+7*DAY):now+3_600_000;
  written+=(await ctx.db.query(`INSERT INTO sourcing_callable_ranks(workspace_id,candidate_id,candidate_revision,run_id,rank,company_host,computed_at,expires_at)
   SELECT c.workspace_id,c.id,c.revision,r.id,$4,$5,$6::timestamptz,$7::timestamptz FROM sourcing_candidates c
   JOIN sourcing_qualification_runs r ON r.workspace_id=c.workspace_id AND r.candidate_id=c.id AND r.id=$3 AND r.candidate_revision=c.revision
   WHERE c.workspace_id=$1 AND c.id=$2 AND c.revision=$8
   ON CONFLICT(workspace_id,candidate_id) DO UPDATE SET candidate_revision=EXCLUDED.candidate_revision,run_id=EXCLUDED.run_id,rank=EXCLUDED.rank,company_host=EXCLUDED.company_host,computed_at=EXCLUDED.computed_at,expires_at=EXCLUDED.expires_at RETURNING 1`,
   [ctx.scope.workspaceId,s.id,s.run_id,rank,usable?.companyHost??null,new Date(now).toISOString(),new Date(expires).toISOString(),s.revision])).rows.length;
 }
 return written;
}
