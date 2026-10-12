import {askSourceCursorSchema,askAgentScopeSchema,type AskAgentScope,type CanonicalSourceReference} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {discoverAskSources,readAskCanonicalCorpus} from './askCorpus.ts';
import {readMailConversation} from '../mail/crmSources.ts';
import {readProcessingContext} from './processingContext.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
const mail=createNativeCrmMailEvidence();
type Cursor={kind:CanonicalSourceReference['kind'];sourceId:string};
export const copiedAskSource=(source:CanonicalSourceReference)=>({workspaceId:source.workspaceId,kind:source.kind,sourceId:source.sourceId,revision:source.revision,contentHash:source.contentHash!,locator:null});
function dated(scope:AskAgentScope,source:CanonicalSourceReference){return (scope.from===undefined||(source.occurredAt!==null&&Date.parse(source.occurredAt)>=Date.parse(scope.from)))&&(scope.to===undefined||(source.occurredAt!==null&&Date.parse(source.occurredAt)<Date.parse(scope.to)));}
/** A bounded current authorized catalog scan. Source ceilings apply AFTER relevance ranking. */
export async function discoverAskHistorySources(context:RepositoryContext,scope:AskAgentScope,input:{after?:Cursor|undefined;candidateCeiling?:number;deadlineAt?:number}={}){
 if(!askAgentScopeSchema.safeParse(scope).success)return null;
 const ceiling=input.candidateCeiling??1000;if(!Number.isInteger(ceiling)||ceiling<1||ceiling>1000)return null;
 const sources:CanonicalSourceReference[]=[];let scannedCandidates=0,after=input.after,partial=false,pages=0;
 if(scope.kind==='selected'){
  for(const ref of scope.sources){const current=await resolveCrmSource(context,ref,mail);if(!current||current.source.availability!=='available'||current.source.contentHash===null)return null;if(dated(scope,current.source))sources.push(current.source);}
  return {sources,partial:false,scannedCandidates:scope.sources.length,nextAfter:null};
 }
 while(scannedCandidates<ceiling&&pages<Math.ceil(ceiling/50)){
  pages++;
  if(input.deadlineAt!==undefined&&Date.now()>=input.deadlineAt){partial=true;break;}
  const page=await discoverAskSources(context,{operation:'sources',scope:scope.kind==='firm'?{firmId:scope.firmId}:scope.kind==='person'?{personId:scope.personId}:{business:true},...after?{after}:{},limit:Math.min(50,ceiling-scannedCandidates)});
  if(!page)return null;scannedCandidates+=page.sources.length;
  for(const source of page.sources)if(source.availability==='available'&&source.contentHash!==null&&source.observedAt!==null){const current={...source,observedAt:source.observedAt};if(dated(scope,current))sources.push(current);};
  partial ||= page.coverage.sizeBoundReached;
  if(page.nextAfter===null)return {sources,partial,scannedCandidates,nextAfter:null};
  if(after?.kind===page.nextAfter.kind&&after.sourceId===page.nextAfter.sourceId)return null;
  after=page.nextAfter;
 }
 return {sources,partial:true,scannedCandidates,nextAfter:after??null};
}
export async function discoverAskIndexSources(context:RepositoryContext,scope:AskAgentScope,limit=100){return discoverAskHistorySources(context,scope,{candidateCeiling:limit});}
/** Browse current authorized retained copies without guessing an original keyword.
 * The continuation follows the last returned copy, never a prefetched page tail.
 */
export async function browseAskHistory(context:RepositoryContext,scope:AskAgentScope,input:{limit:number;after?:Cursor|undefined;deadlineAt?:number}){
 if(!Number.isInteger(input.limit)||input.limit<1||input.limit>5||input.after!==undefined&&!askSourceCursorSchema.safeParse(input.after).success)return null;
 if(!askAgentScopeSchema.safeParse(scope).success)return null;
 if(input.deadlineAt!==undefined&&Date.now()>=input.deadlineAt)return {eligibleSources:[],sources:[],matches:null,partial:true,scannedCandidates:0,nextAfter:input.after??null,retrieval:'bounded_catalog' as const,semantic:'unavailable' as const};
 const catalog=await discoverAskHistorySources(context,scope,{...scope.kind==='selected'||input.after===undefined?{}:{after:input.after},...input.deadlineAt===undefined?{}:{deadlineAt:input.deadlineAt}});if(!catalog)return null;
 const ordered=scope.kind==='selected'?[...catalog.sources].sort((a,b)=>a.kind===b.kind?(a.sourceId===b.sourceId?0:a.sourceId<b.sourceId?-1:1):a.kind<b.kind?-1:1):catalog.sources;
 const after=input.after;
 const eligible=scope.kind==='selected'&&after!==undefined?ordered.filter(source=>source.kind>after.kind||source.kind===after.kind&&source.sourceId>after.sourceId):ordered;
 const sources=eligible.slice(0,input.limit),remaining=eligible.length>sources.length,last=sources.at(-1);
 const nextAfter=remaining&&last?{kind:last.kind,sourceId:last.sourceId}:catalog.nextAfter;
 return {eligibleSources:sources,sources,matches:null,partial:catalog.partial||remaining,scannedCandidates:catalog.scannedCandidates,nextAfter,retrieval:'bounded_catalog' as const,semantic:'unavailable' as const};
}
/** Ordinary questions retrieve ranked alternatives; explicit web-search syntax remains exact. */
function explicitLexicalSyntax(query:string){return /"|(?:^|\s)-\S|\bOR\b/u.test(query);}
export function askLexicalQuery(query:string){return explicitLexicalSyntax(query)?query:query.trim().split(/\s+/u).join(' OR ');}
/** Plain questions use PostgreSQL's English stemming/stopwords; explicit literals keep simple lexemes. */
export function askLexicalConfiguration(query:string){return explicitLexicalSyntax(query)?'simple':'english';}
/** Local PostgreSQL ranking of retained originals; never acquires mail or invokes a model. */
export async function searchAskHistory(context:RepositoryContext,scope:AskAgentScope,input:{query:string;limit:number;after?:Cursor|undefined;deadlineAt?:number}){
 if(input.query.trim().length<1||input.query.length>300||!Number.isInteger(input.limit)||input.limit<1||input.limit>20)return null;
 const catalog=await discoverAskHistorySources(context,scope,{...input.after?{after:input.after}:{},...input.deadlineAt===undefined?{}:{deadlineAt:input.deadlineAt}});if(!catalog)return null;
 const matches:{source:CanonicalSourceReference;locator:string;score:number}[]=[];let partial=catalog.partial;
 for(const source of catalog.sources){
  if(input.deadlineAt!==undefined&&Date.now()>=input.deadlineAt){partial=true;break;}
  const corpus=await readAskCanonicalCorpus(context,{scope:{sources:[copiedAskSource(source)]}});if(!corpus){partial=true;continue;}
  partial ||= corpus.coverage.truncatedSources>0;
  const ranked=(await context.db.query<{locator:string;score:number}>(`SELECT locator,ts_rank_cd(to_tsvector($5::regconfig,text),websearch_to_tsquery($5::regconfig,$3)) AS score FROM unnest($1::text[],$2::text[]) AS windows(locator,text) WHERE to_tsvector($5::regconfig,text) @@ websearch_to_tsquery($5::regconfig,$3) ORDER BY score DESC,locator LIMIT $4`,[corpus.windows.map(window=>window.locator),corpus.windows.map(window=>window.text),askLexicalQuery(input.query),input.limit,askLexicalConfiguration(input.query)])).rows;
  for(const row of ranked)matches.push({source,locator:row.locator,score:Number(row.score)});
 }
 matches.sort((a,b)=>b.score-a.score||a.source.sourceId.localeCompare(b.source.sourceId)||a.locator.localeCompare(b.locator));
 const selected=matches.slice(0,input.limit);const unique=new Map(selected.map(match=>[`${match.source.kind}:${match.source.sourceId}`,match.source]));
 return {eligibleSources:catalog.sources,sources:[...unique.values()],matches:selected,partial:partial||matches.length>input.limit,scannedCandidates:catalog.scannedCandidates,nextAfter:catalog.nextAfter,retrieval:'ranked_lexical' as const,semantic:'unavailable' as const};
}
/** Surrounding retained mail messages or the complete bounded selected/transcript copy. */
export async function readAskConversationSources(context:RepositoryContext,scope:AskAgentScope,input:{sourceId:string;kind:CanonicalSourceReference['kind'];limit:number;deadlineAt?:number;anchor?:Parameters<typeof resolveCrmSource>[1]}){
 if(!Number.isInteger(input.limit)||input.limit<1||input.limit>10)return null;
 const permitted=async(ref:Parameters<typeof resolveCrmSource>[1])=>{const resolved=await resolveCrmSource(context,ref,mail),current=await readProcessingContext(context,ref,mail);if(!resolved||!current||!dated(scope,resolved.source))return null;if(scope.kind==='firm'&&!current.firmIds.includes(scope.firmId)||scope.kind==='person'&&current.personId!==scope.personId||scope.kind==='selected'&&!scope.sources.some(source=>source.kind===ref.kind&&source.sourceId===ref.sourceId&&source.revision===ref.revision&&source.contentHash===ref.contentHash))return null;return resolved.source;};
 let anchor:CanonicalSourceReference|null=null,partial=false;
 if(input.anchor){if(input.anchor.sourceId!==input.sourceId||input.anchor.kind!==input.kind)return null;anchor=await permitted(input.anchor);}
 else{const catalog=await discoverAskHistorySources(context,scope,{...input.deadlineAt===undefined?{}:{deadlineAt:input.deadlineAt}});if(!catalog)return null;anchor=catalog.sources.find(source=>source.kind===input.kind&&source.sourceId===input.sourceId)??null;partial=catalog.partial;}
 if(!anchor)return null;
 if(input.kind!=='mail')return {sources:[anchor],partial,matches:null};
 const thread=(await context.db.query<{conversation_id:string}>('SELECT conversation_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 AND availability=\'available\'',[context.scope.workspaceId,input.sourceId])).rows[0];if(!thread)return null;
 const neighbors=(await context.db.query<{source_id:string;source_revision:number;content_hash:string;provider_at:Date}>(`SELECT source_id,source_revision,content_hash,provider_at FROM crm_mail_sources WHERE workspace_id=$1 AND conversation_id=$2 AND availability='available' ORDER BY abs(extract(epoch FROM (provider_at-(SELECT provider_at FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$3)))),provider_at,source_id LIMIT 1001`,[context.scope.workspaceId,thread.conversation_id,input.sourceId])).rows;
 const current:{source:CanonicalSourceReference;at:Date}[]=[];let scanned=0;
 for(const row of neighbors.slice(0,1000)){if(input.deadlineAt!==undefined&&Date.now()>=input.deadlineAt){partial=true;break;}scanned++;const source=await permitted({workspaceId:context.scope.workspaceId,kind:'mail',sourceId:row.source_id,revision:row.source_revision,contentHash:row.content_hash,locator:null});if(source){current.push({source,at:row.provider_at});if(current.length===input.limit)break;}}
 current.sort((a,b)=>a.at.getTime()-b.at.getTime()||a.source.sourceId.localeCompare(b.source.sourceId));
 return {sources:current.map(row=>row.source),partial:partial||neighbors.length>scanned,matches:null};
}

/** Copy-only attribution; never treats quotes, forwarders or recipients as the speaker. */
export async function readAskConversationAttribution(context:RepositoryContext,sources:readonly CanonicalSourceReference[]){
 const metadata=[];for(const source of sources.slice(0,10)){
  if(source.kind!=='mail'){metadata.push({sourceId:source.sourceId,kind:source.kind,speaker:source.speaker,occurredAt:source.occurredAt,completeness:source.completeness});continue;}
  const read=await readMailConversation(context,{sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash});if(read.state!=='available')return null;
  const copy=read.source;metadata.push({sourceId:source.sourceId,kind:'mail',direction:copy.direction,subject:copy.subject,providerOrigin:copy.providerOrigin,parserVersion:copy.parserVersion,rawSenderDate:copy.rawSenderDate,representationDiagnostics:copy.representationDiagnostics,envelope:copy.envelope,participants:copy.participants,occurredAt:copy.occurredAt,observedAt:copy.observedAt,completeness:copy.completeness,representation:copy.representation,ranges:copy.ranges,sentProof:copy.sentProof,attachments:copy.attachments});
 }return metadata;
}
