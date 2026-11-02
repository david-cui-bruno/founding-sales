import {isDeepStrictEqual} from 'node:util';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {MANUAL_PROSPECT_ROWS_SQL,readManualProspectSubject} from './manualProspectRows.ts';
import type {ManualProspectRow} from './manualProspectProjection.ts';
import {manualPhoneSnapshots,manualPhoneSnapshotsUnlocked,recheckManualPhoneSnapshots,type ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {withPreparedPhoneSnapshots} from './manualProspectPreparedPhone.ts';
import {lockPreparedCaptureDependencies} from './preparedCaptureDependencies.ts';
import {projectPreparedProspect} from './preparedProspectProjection.ts';
import {preparedSnapshotDeadlines} from './preparedSourceDeadlines.ts';
import {admitPreparedPages} from './preparedPageAdmission.ts';
import {PREPARED_PHONE_HORIZON_MS} from './preparedPhoneSource.ts';
import {DISCOVERY_RESEARCH_PREPARED_BY,preparedCandidatePayload} from './discoveryIntake.ts';
import {resolveBusinessName} from './businessName.ts';
import {preparedPriorityOrder} from './prospectPriorityStore.ts';

/** A prepared own-site company (ADR0035/0036): the company the prepared brief calls prepared (business context, no contrary context, a
 * company page) and its business name (`resolveBusinessName`: the name the Firm carries). A company with no confident business name is
 * not read at all, so selection, enrichment, preview and admission refuse it by this one predicate. It carries no address: the person to
 * email comes from the provider (`outreach_people_contacts`). A read, never contact permission. */
/** One retained, admitted own-site page of the prepared capture: its observation, URL and whole text blocks (ADR0037 reads people from these; nothing else of the page is kept). */
export interface PreparedPageText {observationId:string;url:string;blocks:readonly {id:string;text:string}[]}
export interface PreparedEmailRead {candidateId:string;pages:readonly PreparedPageText[];candidateRevision:number;runId:string;host:string;region:string;locality:string;businessName:string;/** ms epoch: the earliest admitted page, capture or source deadline of the prepared evidence (each page at most seven days after retrieval): the company stops being prepared then. */evidenceDeadline:number}
const BLOCKERS=new Set(['needs_research','contrary_context','no_business_context','list_page','not_company_page']);
function emailRead(row:ManualProspectRow,snapshot:ManualPhoneSnapshot|undefined,now:number):PreparedEmailRead|null{
 const deadlines=snapshot&&preparedSnapshotDeadlines(snapshot);
 if(!snapshot||snapshot.dependency_changed||!deadlines)return null;
 const brief=projectPreparedProspect(row,snapshot,{id:snapshot.id,candidate_revision:row.revision},now,deadlines);
 if(!brief||brief.state!=='prepared'||brief.companyHost===null||brief.callable.missing.some(reason=>BLOCKERS.has(reason)))return null;
 const payload=preparedCandidatePayload(snapshot.payload),admitted=admitPreparedPages(snapshot,now,deadlines);
 const evidenceDeadline=Math.min(...admitted.pages.map(page=>Math.min(Date.parse(page.source.retrievedAt)+PREPARED_PHONE_HORIZON_MS,admitted.captureDeadline??Infinity,page.expires??Infinity)));
 if(!Number.isFinite(evidenceDeadline)||evidenceDeadline<=now)return null;
 const businessName=payload&&resolveBusinessName({name:payload.firmName,source:payload.preparedBy===DISCOVERY_RESEARCH_PREPARED_BY?'place':'title',locality:brief.targetingLocality,query:payload.discoveryQuery,host:brief.companyHost,blocks:admitted.pages.flatMap(page=>page.source.blocks.map(block=>block.text))});
 return businessName?{candidateId:row.id,pages:admitted.pages.map(page=>({observationId:page.source.id,url:page.source.url,blocks:page.source.blocks.map(block=>({id:block.id,text:block.text}))})),candidateRevision:row.revision,runId:snapshot.id,host:brief.companyHost,region:brief.targetingRegion,locality:brief.targetingLocality,businessName,evidenceDeadline}:null;
}
const clock=async(ctx:RepositoryContext)=>(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
/** Authoritative current read. Caller holds the source lifecycle, candidate and campaign locks and supplies the owner authority
 * (the approved campaign's active admin owner); same lock order and repeated principal/clock checks as the prepared phone read. */
export async function readPreparedEmail(ctx:RepositoryContext,input:{candidateId:string;expectedRevision:number},authority:()=>Promise<boolean>):Promise<PreparedEmailRead|null>{
 const subject=await readManualProspectSubject(ctx,input);if(!subject)return null;
 const row:ManualProspectRow={...subject,duplicate_count:0},custody={principal:true};
 await lockPreparedCaptureDependencies(ctx,[row]);
 const before=await withPreparedPhoneSnapshots(ctx,[row],await manualPhoneSnapshots(ctx,[row]),custody);
 if(!await authority())return null;
 const checked=await withPreparedPhoneSnapshots(ctx,[row],await recheckManualPhoneSnapshots(ctx,[row],before),custody);
 if(!await authority())return null;
 const current=await withPreparedPhoneSnapshots(ctx,[row],await recheckManualPhoneSnapshots(ctx,[row],before),custody);
 if(!isDeepStrictEqual(before,checked)||!isDeepStrictEqual(before,current))return null;
 return emailRead(row,current[0],await clock(ctx));
}
/** Advisory, nonlocking selection in the prepared list's priority order, one company per host. Admission rereads each choice
 * under locks with `readPreparedEmail`; nothing here grants anything. */
export async function listPreparedEmailCandidates(ctx:RepositoryContext,input:{limit:number;regions:readonly string[];skip:ReadonlySet<string>;/** Applied before the limit and the one-per-host rule, so an excluded company takes neither. It acts only inside the bounded scan below (the first 400 records of the priority order); a scan cursor is the follow-up if refusals ever fill that window. */accept?:(read:PreparedEmailRead)=>boolean|Promise<boolean>}):Promise<PreparedEmailRead[]>{
 const found:PreparedEmailRead[]=[],hosts=new Set<string>();
 for(let offset=0;offset<8*50&&found.length<input.limit;offset+=50){
  const order=await preparedPriorityOrder(ctx,offset),selected=order.rows.slice(0,50).filter(entry=>!input.skip.has(entry.id));
  if(selected.length){
   const all=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_ROWS_SQL}) visible WHERE id=ANY($3::uuid[])`,[ctx.scope.workspaceId,'all',selected.map(entry=>entry.id)])).rows;
   const rows=selected.flatMap(entry=>{const row=all.find(candidate=>candidate.id===entry.id&&candidate.revision===entry.revision);return row?[row]:[];});
   const snapshots=rows.length?await withPreparedPhoneSnapshots(ctx,rows,await manualPhoneSnapshotsUnlocked(ctx,rows),{principal:true,lockless:true}):[],now=await clock(ctx);
   for(const row of rows){
    const read=emailRead(row,snapshots.find(snapshot=>snapshot.candidate_id===row.id),now);
    if(read&&input.regions.includes(read.region)&&!hosts.has(read.host)&&found.length<input.limit&&(await input.accept?.(read)??true)){hosts.add(read.host);found.push(read);}
   }
  }
  if(order.rows.length<=50)break;
 }
 return found;
}
