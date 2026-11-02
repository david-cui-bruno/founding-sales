import {US_BUSINESS_REGIONS} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {localDate} from '../src/rules/localClock.ts';
import {workspaceBusinessZone} from '../research/ledger.ts';
import {readPeopleEnrichmentSetting} from '../settings/peopleEnrichment.ts';
import {lockSettingForRead} from '../settings/store.ts';
import {listPreparedEmailCandidates} from '../sourcing/preparedEmailRead.ts';
import {preparedAdmissionRefusedInAdvance} from './preparedEmailAssessment.ts';
import {admittedCandidateIds} from './preparedEmailSelection.ts';
import {PEOPLE_CONTACT_VALID_DAYS} from './peopleContacts.ts';
import {acceptablePerson,MILLIONVERIFIER_PROVIDER,OWN_SITE_PROVIDER,type AcceptedPerson,type AddressRefusal,type PeopleProvider,type PersonRefusal} from './peopleProvider.ts';

/** ADR0036. A refused uncharged call is tried again after an hour; nothing else is retried. A free source (`own_site`, ADR0037) takes 50 companies a pass: it has no call to pay for.
 * Only the free `own_site` row is read again in place (its thirty days pass or its candidate revision changes). A paid `millionverifier` row is NEVER renewed: its credits and business date are the spend ledger `creditsOnDate` sums, so a changed revision gets a new row (ADR0038). */
const FAILED_COOLDOWN_HOURS=1,STALE_RESERVATION_MINUTES=5,PASS_LOOKUPS=10,FREE_PASS_LOOKUPS=50,RENEWED_PROVIDERS:readonly string[]=[OWN_SITE_PROVIDER],OWN_ROWS_PROVIDERS:readonly string[]=[OWN_SITE_PROVIDER,MILLIONVERIFIER_PROVIDER];
export interface PeopleCompany {candidateId:string;candidateRevision:number;host:string}
/** Credits reserved or spent on this business date, the one number the daily cap is held to. */
export async function creditsOnDate(ctx:RepositoryContext,date:string):Promise<number>{
 return Number((await ctx.db.query<{used:string}>('SELECT coalesce(sum(credits),0)::text AS used FROM outreach_people_lookups WHERE workspace_id=$1 AND business_date=$2::date',[ctx.scope.workspaceId,date])).rows[0]!.used);
}
export const businessDateNow=async(ctx:RepositoryContext):Promise<{zone:string;date:string}>=>{const zone=await workspaceBusinessZone(ctx);return {zone,date:localDate((await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString(),zone)};};
export type PeopleReservation={kind:'reserved';id:string;credits:number}|{kind:'taken'}|{kind:'cap'}|{kind:'disabled'}|{kind:'gone'};
/** Commits (its own transaction) one reservation row BEFORE the paid call (a free source's row holds 0 credits). Under the `people_enrichment` setting's read lock (so an admin's
 * disable or cap change is ordered against it) and the workspace advisory lock it re-reads the switch and the cap, then requires the day's
 * reserved and spent credits plus this lookup's maximum to fit the cap, and the company's HOST to have no custody row (a refused uncharged
 * call's row is reused once its cool-down passes, because it holds no spend; so is the free `own_site` row (`RENEWED_PROVIDERS`) once its thirty days pass or its candidate
 * revision changes: the company's pages are read again and the old person copy is replaced). The daily cap applies only to a lookup that costs
 * credits. A committed reservation counts as spent whatever happens next. */
export async function reservePeopleLookup(ctx:RepositoryContext,input:{provider:string;company:PeopleCompany;credits:number}):Promise<PeopleReservation>{
 const w=ctx.scope.workspaceId,{zone,date}=await businessDateNow(ctx);
 return withTransaction(ctx.db,async()=>{
  await lockSettingForRead(ctx,'people_enrichment');
  const setting=await readPeopleEnrichmentSetting(ctx);
  if(!setting.enabled||setting.dailyCredits<input.credits)return {kind:'disabled'};
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`people-enrichment:${w}`]);
  if(input.credits>0&&await creditsOnDate(ctx,date)+input.credits>setting.dailyCredits)return {kind:'cap'};
  // Custody has no foreign key to the candidate, so the candidate is checked and share-locked here: one deleted since the list was read is neither reserved nor called.
  if(!(await ctx.db.query('SELECT 1 FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR SHARE',[w,input.company.candidateId])).rows.length)return {kind:'gone'};
  // A paid attempt whose outcome is uncertain (`unknown`: the request went out and may have charged; `reserved`: in flight) and a settled negative answer (`verdict_invalid`/`verdict_disposable`) fence the COMPANY, by candidate OR host, for their thirty days whatever the candidate revision or person expiry: a revision change or a replacement candidate on the same host never makes a second paid call (the database no longer holds the per-host fence for this provider; this check, under the workspace advisory lock, does).
  if(!RENEWED_PROVIDERS.includes(input.provider)&&(await ctx.db.query("SELECT 1 FROM outreach_people_lookups WHERE workspace_id=$1 AND provider=$3 AND (candidate_id=$2 OR host=$4) AND expires_at>clock_timestamp() AND (state IN ('unknown','reserved') OR (state='none' AND reason IN ('verdict_invalid','verdict_disposable'))) LIMIT 1",[w,input.company.candidateId,input.provider,input.company.host])).rows.length)return {kind:'taken'};
  const reused=(await ctx.db.query<{id:string}>(`UPDATE outreach_people_lookups SET state='reserved',reason=NULL,candidate_id=$2,candidate_revision=$4,credits=$5,business_date=$6::date,business_time_zone=$7,reserved_at=clock_timestamp(),observed_at=NULL,expires_at=clock_timestamp()+make_interval(days=>$8)
   WHERE workspace_id=$1 AND host=$9 AND provider=$3 AND ((state='failed' AND expires_at<=clock_timestamp() AND ($10 OR (candidate_id=$2 AND candidate_revision=$4))) OR ($10 AND state<>'reserved' AND (expires_at<=clock_timestamp() OR candidate_revision<>$4))) RETURNING id`,[w,input.company.candidateId,input.provider,input.company.candidateRevision,input.credits,date,zone,PEOPLE_CONTACT_VALID_DAYS,input.company.host,RENEWED_PROVIDERS.includes(input.provider)])).rows[0];
  if(reused){await ctx.db.query('DELETE FROM outreach_people_contacts WHERE workspace_id=$1 AND lookup_id=$2',[w,reused.id]);return {kind:'reserved',id:reused.id,credits:input.credits};}
  const row=(await ctx.db.query<{id:string}>(`INSERT INTO outreach_people_lookups(workspace_id,candidate_id,candidate_revision,host,provider,state,credits,business_date,business_time_zone,expires_at)
   VALUES($1,$2,$3,$4,$5,'reserved',$6,$7::date,$8,clock_timestamp()+make_interval(days=>$9)) ON CONFLICT DO NOTHING RETURNING id`,[w,input.company.candidateId,input.company.candidateRevision,input.company.host,input.provider,input.credits,date,zone,PEOPLE_CONTACT_VALID_DAYS])).rows[0];
  return row?{kind:'reserved',id:row.id,credits:input.credits}:{kind:'taken'};
 });
}
export type Settlement={state:'found';person:AcceptedPerson;credits:number;/** ms epoch of the cited page's own deadline (an own-site person): the person is current no longer than it. */citedDeadline:number|null}|{state:'none';reason:PersonRefusal|AddressRefusal;credits:number}|{state:'failed';reason:string}|{state:'unknown';reason:string};
/** One statement settles a reservation that is still reserved. A failed settle leaves it reserved; the next pass reads it as unknown. */
export async function settlePeopleLookup(ctx:RepositoryContext,id:string,s:Settlement):Promise<void>{
 const w=ctx.scope.workspaceId;
 if(s.state==='found')await withTransaction(ctx.db,async()=>{
  const settled=await ctx.db.query(`UPDATE outreach_people_lookups SET state='found',reason=NULL,credits=$3,observed_at=clock_timestamp(),expires_at=CASE WHEN $4::double precision IS NULL THEN expires_at ELSE greatest(reserved_at+interval '1 millisecond',least(expires_at,to_timestamp($4::double precision/1000))) END WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.credits,s.citedDeadline]);
  if(settled.rowCount)await ctx.db.query(`INSERT INTO outreach_people_contacts(workspace_id,lookup_id,candidate_id,host,provider_person_id,first_name,last_name,title,email,email_status,match_confidence,source_url,source_block_id,source_quote)
   SELECT workspace_id,id,candidate_id,host,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 FROM outreach_people_lookups WHERE workspace_id=$1 AND id=$2`,[w,id,s.person.providerPersonId,s.person.firstName,s.person.lastName,s.person.title,s.person.email,s.person.emailStatus,s.person.confidence,s.person.source?.url??null,s.person.source?.blockId??null,s.person.source?.quote??null]);
 });
 else if(s.state==='none')await ctx.db.query(`UPDATE outreach_people_lookups SET state='none',reason=$3,credits=$4,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason,s.credits]);
 else if(s.state==='failed')await ctx.db.query(`UPDATE outreach_people_lookups SET state='failed',reason=$3,credits=0,expires_at=clock_timestamp()+make_interval(hours=>$4) WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason,FAILED_COOLDOWN_HOURS]);
 else await ctx.db.query(`UPDATE outreach_people_lookups SET state='unknown',reason=$3 WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,[w,id,s.reason]);
}
/** A reservation whose call never settled (a crash, a lost connection, a rolled-back write) may have been charged: it is unknown (reason `interrupted`, told apart from a call's own failure), keeps its credits and is never retried. */
export async function markStaleReservations(ctx:RepositoryContext):Promise<void>{
 await ctx.db.query(`UPDATE outreach_people_lookups SET state='unknown',reason='interrupted' WHERE workspace_id=$1 AND state='reserved' AND reserved_at<clock_timestamp()-make_interval(mins=>$2)`,[ctx.scope.workspaceId,STALE_RESERVATION_MINUTES]);
}

export interface PeopleEnrichmentPass {looked:number;found:number;none:number;credits:number;/** The provider failure code that halted the pass, if any. */halted:string|null;/** Why nothing ran: `disabled` or `cap`. */stopped:'disabled'|'cap'|null}
/** Regions to enrich: the active campaign's (an approved, unrevoked, unexpired one), else every region so the first admissions can be previewed before approval. */
export async function enrichmentRegions(ctx:RepositoryContext):Promise<string[]>{
 const rows=(await ctx.db.query<{regions:string[]}>('SELECT regions FROM outreach_email_campaigns WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()',[ctx.scope.workspaceId])).rows;
 return rows.length?[...new Set(rows.flatMap(row=>row.regions))]:[...US_BUSINESS_REGIONS];
}
/** Candidates and hosts the ACTIVE provider's extraction skips (ADR0037): `own_site` and `millionverifier` skip only what their OWN rows hold; an old paid provider's row blocks that provider's re-lookups only. A failed row is skipped until its cool-down passes; an `own_site` row that is expired, or older than its candidate's revision, is read again (see `reservePeopleLookup`) and holds nothing; a settled `millionverifier` row of an earlier candidate revision holds nothing for the current one (its row stays as spend), but an uncertain one (`unknown`, `reserved`) holds the company for its thirty days whatever the revision. Accounting (`creditsOnDate`, the unique fences) still sees every provider's rows. */
export const enrichedCustody=async(ctx:RepositoryContext,provider:string):Promise<{candidates:Set<string>;hosts:Set<string>}>=>{
 const rows=(await ctx.db.query<{candidate_id:string;host:string}>(`SELECT l.candidate_id,l.host FROM outreach_people_lookups l LEFT JOIN sourcing_candidates c ON c.workspace_id=l.workspace_id AND c.id=l.candidate_id
  WHERE l.workspace_id=$1 AND (l.provider=$3::text OR NOT $3::text=ANY($2::text[])) AND NOT (l.state='failed' AND l.expires_at<=clock_timestamp()) AND NOT (l.provider=$4::text AND l.state<>'reserved' AND (l.expires_at<=clock_timestamp() OR l.candidate_revision IS DISTINCT FROM c.revision)) AND NOT (l.provider=$5::text AND l.candidate_revision IS DISTINCT FROM c.revision AND NOT (l.state IN ('unknown','reserved') AND l.expires_at>clock_timestamp()))`,[ctx.scope.workspaceId,OWN_ROWS_PROVIDERS,provider,OWN_SITE_PROVIDER,MILLIONVERIFIER_PROVIDER])).rows;
 return {candidates:new Set(rows.map(row=>row.candidate_id)),hosts:new Set(rows.map(row=>row.host))};
};
/** ADR0036/0037. The worker's enrichment pass: in the prepared list's order (one company per host; the prepared brief, business name, no existing
 * Firm and a resolvable zone, but no published address) reserve, call the source once, record. It stops at the daily credit cap (a free source has none) and on
 * the first provider failure (nothing is retried inside the pass). Runs outside any transaction: each reservation and settlement commits
 * on its own, so a crash after the reservation never lets a company be paid for twice. */
export async function runPeopleEnrichment(ctx:RepositoryContext,deps:{provider:PeopleProvider}):Promise<PeopleEnrichmentPass>{
 const pass:PeopleEnrichmentPass={looked:0,found:0,none:0,credits:0,halted:null,stopped:null},{provider}=deps;
 const setting=await readPeopleEnrichmentSetting(ctx);
 const free=provider.maxCreditsPerLookup===0;
 if(!setting.enabled||setting.dailyCredits<provider.maxCreditsPerLookup){pass.stopped='disabled';return pass;}// Only a pre-check: every reservation re-reads and locks the switch and the cap.
 await markStaleReservations(ctx);
 // Nothing to scan for once the day's cap is spent: the pass ends without reading the prepared list. A free source has no cap.
 if(!free&&await creditsOnDate(ctx,(await businessDateNow(ctx)).date)+provider.maxCreditsPerLookup>setting.dailyCredits){pass.stopped='cap';return pass;}
 const custody=await enrichedCustody(ctx,provider.providerKey),skip=custody.candidates;for(const id of await admittedCandidateIds(ctx))skip.add(id);
 const refused=async(read:Parameters<typeof preparedAdmissionRefusedInAdvance>[2])=>preparedAdmissionRefusedInAdvance(ctx,null,read);
 const batch=await listPreparedEmailCandidates(ctx,{limit:free?FREE_PASS_LOOKUPS:PASS_LOOKUPS,regions:await enrichmentRegions(ctx),skip,accept:async read=>!custody.hosts.has(read.host)&&!await refused(read)});
 for(const company of batch){
  const reservation=await reservePeopleLookup(ctx,{provider:provider.providerKey,company,credits:provider.maxCreditsPerLookup});
  if(reservation.kind==='cap'||reservation.kind==='disabled'){pass.stopped=reservation.kind==='cap'?'cap':'disabled';break;}
  if(reservation.kind==='taken'||reservation.kind==='gone')continue;
  pass.looked++;
  let lookup;
  try{lookup=await provider.findDecisionMaker({domain:company.host,companyName:company.businessName,candidateId:company.candidateId,pages:company.pages});}
  catch{lookup={ok:false as const,code:'unavailable' as const,mayHaveCharged:true};}
  if(!lookup.ok){
   await settlePeopleLookup(ctx,reservation.id,lookup.mayHaveCharged?{state:'unknown',reason:lookup.code}:{state:'failed',reason:lookup.code});
   pass.halted=lookup.code;if(lookup.mayHaveCharged)pass.credits+=reservation.credits;break;
  }
  const credits=Math.min(Math.max(0,Math.trunc(lookup.creditsUsed)),9);pass.credits+=credits;
  const accepted=acceptablePerson(lookup.person,company.host);
  // An own-site person is current only while the page it cites is: its custody row expires with that page's own deadline, and a citation to no admitted page is no person.
  const cited=accepted.ok&&accepted.person.source?company.pages.find(page=>page.url===accepted.person.source!.url):undefined;
  if(accepted.ok&&accepted.person.source&&!cited){await settlePeopleLookup(ctx,reservation.id,{state:'none',reason:'no_person',credits});pass.none++;}
  else if(accepted.ok){await settlePeopleLookup(ctx,reservation.id,{state:'found',person:accepted.person,credits,citedDeadline:cited?.deadline??null});pass.found++;}
  else{await settlePeopleLookup(ctx,reservation.id,{state:'none',reason:accepted.reason,credits});pass.none++;}
 }
 return pass;
}

/** Companies the provider has not yet been asked about that the next pass could take: the preview's "awaiting enrichment" count (bounded by the scan). */
export async function countAwaitingEnrichment(ctx:RepositoryContext,regions:readonly string[],provider:string=OWN_SITE_PROVIDER):Promise<number>{
 const custody=await enrichedCustody(ctx,provider),skip=custody.candidates;for(const id of await admittedCandidateIds(ctx))skip.add(id);
 return (await listPreparedEmailCandidates(ctx,{limit:1000,regions,skip,accept:async read=>!custody.hosts.has(read.host)&&!await preparedAdmissionRefusedInAdvance(ctx,null,read)})).length;
}
