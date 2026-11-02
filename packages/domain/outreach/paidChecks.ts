import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {readPeopleEnrichmentSetting} from '../settings/peopleEnrichment.ts';
import {lockSettingForRead} from '../settings/store.ts';
import {PEOPLE_CONTACT_VALID_DAYS} from './peopleContacts.ts';
import {businessDateNow,creditsOnDate,type PeopleCompany,type PeopleReservation} from './peopleEnrichment.ts';
import type {AddressRefusal} from './peopleProvider.ts';

/** ADR0038. The paid single-address check's own spend ledger (`outreach_people_paid_checks`, migration 0162): the ADR0036 reservation protocol (reserve BEFORE the paid call under the setting's lock and the workspace
 * advisory lock, re-reading the switch and the cap; settle after) over a table where a row is NEVER renewed. One row per candidate REVISION (the database's fence), so a changed revision adds a row and the earlier
 * charge stays in the day's count; the company is fenced by candidate OR host while an attempt is unresolved (`reserved`, `unknown`) or its answer was negative (`verdict_invalid`, `verdict_disposable`) for the row's thirty days,
 * whatever the candidate revision, person expiry or replacement candidate on the same host. An uncharged refusal (`failed`) is tried again after an hour. */
const FAILED_COOLDOWN_HOURS=1,STALE_RESERVATION_MINUTES=5;
export type PaidCheckKind='guess'|'published';
export type PaidSettlement={state:'none';reason:AddressRefusal;credits:0|1}|{state:'failed';reason:string}|{state:'unknown';reason:string};
/** Commits (its own transaction) one reservation row BEFORE the paid call. `credits` is the most the call can cost: 1 for a request to the verifier, 0 for the free no-mail-domain refusal. */
export async function reservePaidCheck(ctx:RepositoryContext,input:{kind:PaidCheckKind;company:PeopleCompany;credits:0|1}):Promise<PeopleReservation>{
 const w=ctx.scope.workspaceId,{zone,date}=await businessDateNow(ctx);
 return withTransaction(ctx.db,async()=>{
  await lockSettingForRead(ctx,'people_enrichment');
  const setting=await readPeopleEnrichmentSetting(ctx);
  if(!setting.enabled||setting.dailyCredits<1)return {kind:'disabled'};
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`people-enrichment:${w}`]);
  if(input.credits>0&&await creditsOnDate(ctx,date)+input.credits>setting.dailyCredits)return {kind:'cap'};
  if(!(await ctx.db.query('SELECT 1 FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR SHARE',[w,input.company.candidateId])).rows.length)return {kind:'gone'};
  if(await companyHeldByPaidCheck(ctx,input.company.candidateId,input.company.host))return {kind:'taken'};
  const args=[w,input.company.candidateId,input.company.candidateRevision,input.kind,input.credits,date,zone,PEOPLE_CONTACT_VALID_DAYS];
  const reused=(await ctx.db.query<{id:string}>(`UPDATE outreach_people_paid_checks SET kind=$4,state='reserved',reason=NULL,credits=$5,business_date=$6::date,business_time_zone=$7,reserved_at=clock_timestamp(),observed_at=NULL,expires_at=clock_timestamp()+make_interval(days=>$8)
   WHERE workspace_id=$1 AND candidate_id=$2 AND candidate_revision=$3 AND state='failed' AND expires_at<=clock_timestamp() RETURNING id`,args)).rows[0];
  if(reused)return {kind:'reserved',id:reused.id,credits:input.credits};
  const row=(await ctx.db.query<{id:string}>(`INSERT INTO outreach_people_paid_checks(workspace_id,candidate_id,candidate_revision,host,kind,state,credits,business_date,business_time_zone,expires_at)
   VALUES($1,$2,$3,$9,$4,'reserved',$5,$6::date,$7,clock_timestamp()+make_interval(days=>$8)) ON CONFLICT DO NOTHING RETURNING id`,[...args,input.company.host])).rows[0];
  return row?{kind:'reserved',id:row.id,credits:input.credits}:{kind:'taken'};
 });
}
/** The company-wide fence, by candidate OR host: an unresolved attempt or a negative answer inside its thirty days. */
const companyHeldByPaidCheck=async(ctx:RepositoryContext,candidateId:string,host:string):Promise<boolean>=>(await ctx.db.query(`SELECT 1 FROM outreach_people_paid_checks WHERE workspace_id=$1 AND (candidate_id=$2 OR host=$3) AND expires_at>clock_timestamp()
 AND (state IN ('unknown','reserved') OR (state='none' AND reason IN ('verdict_invalid','verdict_disposable'))) LIMIT 1`,[ctx.scope.workspaceId,candidateId,host])).rows.length>0;
/** One statement settles a reservation that is still reserved. A failed settle leaves it reserved; the next pass reads it as unknown. */
export async function settlePaidCheck(ctx:RepositoryContext,id:string,s:PaidSettlement):Promise<void>{
 const w=ctx.scope.workspaceId;
 if(s.state==='none')await ctx.db.query(`UPDATE outreach_people_paid_checks SET state='none',reason=$3,credits=$4,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason,s.credits]);
 else if(s.state==='failed')await ctx.db.query(`UPDATE outreach_people_paid_checks SET state='failed',reason=$3,credits=0,expires_at=clock_timestamp()+make_interval(hours=>$4) WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason,FAILED_COOLDOWN_HOURS]);
 else await ctx.db.query(`UPDATE outreach_people_paid_checks SET state='unknown',reason=$3 WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason]);
}
/** A reservation whose request never settled (a crash, a lost connection, a rolled-back write) may have been charged: it is unknown (reason `interrupted`, told apart from a call's own failure), keeps its credit and is never retried. */
export async function markStalePaidChecks(ctx:RepositoryContext):Promise<void>{
 await ctx.db.query(`UPDATE outreach_people_paid_checks SET state='unknown',reason='interrupted' WHERE workspace_id=$1 AND state='reserved' AND reserved_at<clock_timestamp()-make_interval(mins=>$2)`,[ctx.scope.workspaceId,STALE_RESERVATION_MINUTES]);
}
/** Candidates and hosts the guess pass skips: a check of the candidate's CURRENT revision (any state but a refusal whose cool-down passed), or an unresolved one of any revision inside its window. */
export async function paidCheckCustody(ctx:RepositoryContext):Promise<{candidates:Set<string>;hosts:Set<string>}>{
 const rows=(await ctx.db.query<{candidate_id:string;host:string}>(`SELECT p.candidate_id,p.host FROM outreach_people_paid_checks p LEFT JOIN sourcing_candidates c ON c.workspace_id=p.workspace_id AND c.id=p.candidate_id
  WHERE p.workspace_id=$1 AND NOT (p.state='failed' AND p.expires_at<=clock_timestamp()) AND (p.candidate_revision IS NOT DISTINCT FROM c.revision OR (p.state IN ('unknown','reserved') AND p.expires_at>clock_timestamp()))`,[ctx.scope.workspaceId])).rows;
 return {candidates:new Set(rows.map(row=>row.candidate_id)),hosts:new Set(rows.map(row=>row.host))};
}
