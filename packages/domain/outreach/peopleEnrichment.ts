import {US_BUSINESS_REGIONS} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {localDate} from '../src/rules/localClock.ts';
import {workspaceBusinessZone} from '../research/ledger.ts';
import {readPeopleEnrichmentSetting} from '../settings/peopleEnrichment.ts';
import {listPreparedEmailCandidates} from '../sourcing/preparedEmailRead.ts';
import {preparedAdmissionRefusedInAdvance} from './preparedEmailAssessment.ts';
import {admittedCandidateIds} from './preparedEmailSelection.ts';
import {PEOPLE_CONTACT_VALID_DAYS} from './peopleContacts.ts';
import {acceptablePerson,type AcceptedPerson,type PeopleProvider,type PersonRefusal} from './peopleProvider.ts';

/** ADR0036. A refused uncharged call is tried again after an hour; nothing else is retried. */
const FAILED_COOLDOWN_HOURS=1,STALE_RESERVATION_MINUTES=5,PASS_LOOKUPS=10;
export interface PeopleCompany {candidateId:string;candidateRevision:number;host:string}
/** Credits reserved or spent on this business date, the one number the daily cap is held to. */
async function creditsOnDate(ctx:RepositoryContext,date:string):Promise<number>{
 return Number((await ctx.db.query<{used:string}>('SELECT coalesce(sum(credits),0)::text AS used FROM outreach_people_contacts WHERE workspace_id=$1 AND business_date=$2::date',[ctx.scope.workspaceId,date])).rows[0]!.used);
}
const businessDateNow=async(ctx:RepositoryContext):Promise<{zone:string;date:string}>=>{const zone=await workspaceBusinessZone(ctx);return {zone,date:localDate((await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString(),zone)};};
export type PeopleReservation={kind:'reserved';id:string;credits:number}|{kind:'taken'}|{kind:'cap'};
/** Commits (its own transaction, under a workspace advisory lock) one reservation row BEFORE the paid call: the day's reserved and spent
 * credits plus this lookup's maximum must fit the cap, and the company must have no row (a refused uncharged call's row is reused once
 * its cool-down passes, because it holds no spend). A committed reservation counts as spent whatever happens next. */
export async function reservePeopleLookup(ctx:RepositoryContext,input:{provider:string;company:PeopleCompany;credits:number;dailyCredits:number}):Promise<PeopleReservation>{
 const w=ctx.scope.workspaceId,{zone,date}=await businessDateNow(ctx);
 return withTransaction(ctx.db,async()=>{
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`people-enrichment:${w}`]);
  if(await creditsOnDate(ctx,date)+input.credits>input.dailyCredits)return {kind:'cap'};
  const reused=(await ctx.db.query<{id:string}>(`UPDATE outreach_people_contacts SET state='reserved',reason=NULL,candidate_revision=$4,credits=$5,business_date=$6::date,business_time_zone=$7,reserved_at=clock_timestamp(),observed_at=NULL,expires_at=clock_timestamp()+make_interval(days=>$8)
   WHERE workspace_id=$1 AND candidate_id=$2 AND provider=$3 AND state='failed' AND expires_at<=clock_timestamp() RETURNING id`,[w,input.company.candidateId,input.provider,input.company.candidateRevision,input.credits,date,zone,PEOPLE_CONTACT_VALID_DAYS])).rows[0];
  if(reused)return {kind:'reserved',id:reused.id,credits:input.credits};
  const row=(await ctx.db.query<{id:string}>(`INSERT INTO outreach_people_contacts(workspace_id,candidate_id,candidate_revision,host,provider,state,credits,business_date,business_time_zone,expires_at)
   VALUES($1,$2,$3,$4,$5,'reserved',$6,$7::date,$8,clock_timestamp()+make_interval(days=>$9)) ON CONFLICT DO NOTHING RETURNING id`,[w,input.company.candidateId,input.company.candidateRevision,input.company.host,input.provider,input.credits,date,zone,PEOPLE_CONTACT_VALID_DAYS])).rows[0];
  return row?{kind:'reserved',id:row.id,credits:input.credits}:{kind:'taken'};
 });
}
type Settlement={state:'found';person:AcceptedPerson;credits:number}|{state:'none';reason:PersonRefusal;credits:number}|{state:'failed';reason:string}|{state:'unknown';reason:string};
/** One statement settles a reservation that is still reserved. A failed settle leaves it reserved; the next pass reads it as unknown. */
async function settle(ctx:RepositoryContext,id:string,s:Settlement):Promise<void>{
 const w=ctx.scope.workspaceId;
 if(s.state==='found')await ctx.db.query(`UPDATE outreach_people_contacts SET state='found',reason=NULL,provider_person_id=$3,first_name=$4,last_name=$5,title=$6,email=$7,email_status='verified',match_confidence=$8,credits=$9,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.person.providerPersonId,s.person.firstName,s.person.lastName,s.person.title,s.person.email,s.person.confidence,s.credits]);
 else if(s.state==='none')await ctx.db.query(`UPDATE outreach_people_contacts SET state='none',reason=$3,credits=$4,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason,s.credits]);
 else if(s.state==='failed')await ctx.db.query(`UPDATE outreach_people_contacts SET state='failed',reason=$3,credits=0,expires_at=clock_timestamp()+make_interval(hours=>$4) WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason,FAILED_COOLDOWN_HOURS]);
 else await ctx.db.query(`UPDATE outreach_people_contacts SET state='unknown',reason=$3 WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason]);
}
/** A reservation whose call never settled (a crash, a lost connection) may have been charged: it is unknown, keeps its credits and is never retried. */
async function markStaleReservations(ctx:RepositoryContext):Promise<void>{
 await ctx.db.query(`UPDATE outreach_people_contacts SET state='unknown',reason='unavailable' WHERE workspace_id=$1 AND state='reserved' AND reserved_at<clock_timestamp()-make_interval(mins=>$2)`,[ctx.scope.workspaceId,STALE_RESERVATION_MINUTES]);
}

export interface PeopleEnrichmentPass {looked:number;found:number;none:number;credits:number;/** The provider failure code that halted the pass, if any. */halted:string|null;/** Why nothing ran: `disabled` or `cap`. */stopped:'disabled'|'cap'|null}
/** Regions to enrich: the active campaign's (an approved, unrevoked, unexpired one), else every region so the first admissions can be previewed before approval. */
async function enrichmentRegions(ctx:RepositoryContext):Promise<string[]>{
 const rows=(await ctx.db.query<{regions:string[]}>('SELECT regions FROM outreach_email_campaigns WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[ctx.scope.workspaceId])).rows;
 return rows.length?[...new Set(rows.flatMap(row=>row.regions))]:[...US_BUSINESS_REGIONS];
}
const enrichedCandidateIds=async(ctx:RepositoryContext):Promise<Set<string>>=>new Set((await ctx.db.query<{candidate_id:string}>("SELECT candidate_id FROM outreach_people_contacts WHERE workspace_id=$1 AND NOT (state='failed' AND expires_at<=clock_timestamp())",[ctx.scope.workspaceId])).rows.map(row=>row.candidate_id));
/** ADR0036. The worker's enrichment pass: in the prepared list's order (one company per host; the prepared brief, business name, no existing
 * Firm and a resolvable zone, but no published address) reserve, call the provider once, record. It stops at the daily credit cap and on
 * the first provider failure (nothing is retried inside the pass). Runs outside any transaction: each reservation and settlement commits
 * on its own, so a crash after the reservation never lets a company be paid for twice. */
export async function runPeopleEnrichment(ctx:RepositoryContext,deps:{provider:PeopleProvider}):Promise<PeopleEnrichmentPass>{
 const pass:PeopleEnrichmentPass={looked:0,found:0,none:0,credits:0,halted:null,stopped:null},{provider}=deps;
 const setting=await readPeopleEnrichmentSetting(ctx);
 if(!setting.enabled||setting.dailyCredits<provider.maxCreditsPerLookup){pass.stopped='disabled';return pass;}
 await markStaleReservations(ctx);
 // Nothing to scan for once the day's cap is spent: the pass ends without reading the prepared list.
 if(await creditsOnDate(ctx,(await businessDateNow(ctx)).date)+provider.maxCreditsPerLookup>setting.dailyCredits){pass.stopped='cap';return pass;}
 const skip=await enrichedCandidateIds(ctx);for(const id of await admittedCandidateIds(ctx))skip.add(id);
 const refused=async(read:Parameters<typeof preparedAdmissionRefusedInAdvance>[2])=>preparedAdmissionRefusedInAdvance(ctx,null,read);
 const batch=await listPreparedEmailCandidates(ctx,{limit:PASS_LOOKUPS,regions:await enrichmentRegions(ctx),skip,accept:async read=>!await refused(read)});
 for(const company of batch){
  const reservation=await reservePeopleLookup(ctx,{provider:provider.providerKey,company,credits:provider.maxCreditsPerLookup,dailyCredits:setting.dailyCredits});
  if(reservation.kind==='cap'){pass.stopped='cap';break;}
  if(reservation.kind==='taken')continue;
  pass.looked++;
  let lookup;
  try{lookup=await provider.findDecisionMaker({domain:company.host,companyName:company.businessName});}
  catch{lookup={ok:false as const,code:'unavailable' as const,mayHaveCharged:true};}
  if(!lookup.ok){
   await settle(ctx,reservation.id,lookup.mayHaveCharged?{state:'unknown',reason:lookup.code}:{state:'failed',reason:lookup.code});
   pass.halted=lookup.code;if(lookup.mayHaveCharged)pass.credits+=reservation.credits;break;
  }
  const credits=Math.min(Math.max(0,Math.trunc(lookup.creditsUsed)),9);pass.credits+=credits;
  const accepted=acceptablePerson(lookup.person,company.host);
  if(accepted.ok){await settle(ctx,reservation.id,{state:'found',person:accepted.person,credits});pass.found++;}
  else{await settle(ctx,reservation.id,{state:'none',reason:accepted.reason,credits});pass.none++;}
 }
 return pass;
}

/** Companies the provider has not yet been asked about that the next pass could take: the preview's "awaiting enrichment" count (bounded by the scan). */
export async function countAwaitingEnrichment(ctx:RepositoryContext,regions:readonly string[]):Promise<number>{
 const skip=await enrichedCandidateIds(ctx);for(const id of await admittedCandidateIds(ctx))skip.add(id);
 return (await listPreparedEmailCandidates(ctx,{limit:1000,regions,skip,accept:async read=>!await preparedAdmissionRefusedInAdvance(ctx,null,read)})).length;
}
