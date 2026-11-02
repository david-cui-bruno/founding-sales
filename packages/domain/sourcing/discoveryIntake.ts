import {createHash,randomUUID} from 'node:crypto';
import {legacyCandidateInputSchema,currentPreparedCandidateInputSchema,discoveryCandidatePayloadSchema,discoveryIntakeSaveInputSchema,discoveryIntakeListInputSchema,discoveryIntakeListSchema,type discoveryIntakeSavedSchema,discoveryOriginSchema,discoverySourceKey,type CandidateInput,type LegacyCandidateInput,type DiscoveryIntakeSaveInput,type DiscoveryOrigin} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {lockPreparationCleanup} from '../calling/preparationLifecycle.ts';
import {US_BUSINESS_REGIONS} from '../../contracts/src/usBusinessGeography.ts';

type Result<T>={ok:true;value:T}|{ok:false;reason:string};
type Saved=z.infer<typeof discoveryIntakeSavedSchema>;
type Payload=z.infer<typeof discoveryCandidatePayloadSchema>;
interface CandidateRow {id:string;payload:unknown;status:'needs_review'|'kept'|'dismissed';revision:number;created_at:Date;[key:string]:unknown}
interface OriginRow {candidate_id:string;source:unknown;source_metadata:unknown;licenses:unknown;notices:unknown;[key:string]:unknown}
const refused=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item!==null&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
/** Frozen admission/retained-phone payload guard. Current preparation must not widen it. */
export const isLegacyCandidatePayload=(value:unknown):value is LegacyCandidateInput=>legacyCandidateInputSchema.safeParse(value).success;
export const isCurrentPreparedCandidatePayload=(value:unknown):value is CandidateInput=>currentPreparedCandidateInputSchema.safeParse(value).success;
export const DISCOVERY_LEGACY_EXCLUSION="payload->>'kind' IS DISTINCT FROM 'discovery-v1'";
/** ADR0034: a raw Overture observation with its own website is researched as the ordinary seed it implies. The seed is
 * only ever built in memory (the stored candidate keeps its raw payload) and is not authority beyond own-site research:
 * the website is the only source and an http reference is read as https. A bare host is not a website reference here, as in manual projection. */
const DISCOVERY_RESEARCH_PREPARED_BY='Overture Maps place · not verified';
export function discoveryResearchSeed(value:unknown):CandidateInput|null {
 const raw=discoveryCandidatePayloadSchema.safeParse(value);if(!raw.success)return null;
 const row=raw.data.row,site=row.website?.trim();
 if(!site||!/^https?:\/\//iu.test(site))return null;
 // The fetcher records pages by their normalized href; the seed names the landing page the same way.
 let website:string;try{const url=new URL(site.replace(/^http:/iu,'https:'));url.hash='';website=url.href;}catch{return null;}
 const seed=currentPreparedCandidateInputSchema.safeParse({firmName:row.firmName,website,locality:row.locality??'',region:row.region??'',signal:'fit_only',
  evidence:'Overture Maps place record; the company, website and place are not independently verified.',sourceUrl:website,observedOn:(row.source.retrievedAt??row.source.release).slice(0,10),preparedBy:DISCOVERY_RESEARCH_PREPARED_BY});
 return seed.success?seed.data:null;
}
/** The payload qualification reads: an ordinary prepared candidate, or the research seed of a raw Overture observation. */
export function preparedCandidatePayload(value:unknown):CandidateInput|null {
 const ordinary=currentPreparedCandidateInputSchema.safeParse(value);
 return ordinary.success?ordinary.data:discoveryResearchSeed(value);
}
/** Scheduling predicate for `discoveryResearchSeed` (alias = sourcing_candidates). It must not admit a row the seed refuses,
 * or a refused row would keep its place at the head of the never-researched queue. A manually skipped row is left alone. */
export const discoveryResearchEligibleSql=(c:string)=>`(${c}.payload->>'kind'='discovery-v1' AND ${c}.status='needs_review'
 AND btrim(${c}.payload->'row'->>'website') ~* '^https?://([a-z0-9-]+[.])+[a-z]{2,}(/[^[:space:]]*)?$'
 AND NOT btrim(${c}.payload->'row'->>'website') ~* '^https?://[^/]*[.](local|internal|localhost)(/|$)' AND char_length(btrim(${c}.payload->'row'->>'website'))<=490
 AND char_length(btrim(${c}.payload->'row'->>'locality')) BETWEEN 1 AND 120
 AND ${c}.payload->'row'->>'region' IN (${US_BUSINESS_REGIONS.map(region=>`'${region}'`).join(',')})
 AND (${c}.payload->'row'->'source'->>'retrievedAt' IS NOT NULL OR ${c}.payload->'row'->'source'->>'release' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}')
 AND NOT EXISTS(SELECT 1 FROM sourcing_manual_prospect_states skipped WHERE skipped.workspace_id=${c}.workspace_id AND skipped.candidate_id=${c}.id AND skipped.state='skipped'))`;
/** One company, one research: the candidate that stands for each company host in workspace $1 (companyHost: lowercase, no www.), so
 * David is not given two briefs for one company. Order: a kept or Tavily candidate, then an Overture place that already has a run,
 * then the earliest place that would otherwise be scheduled. A place that is not its host's winner is not due. */
export const DISCOVERY_RESEARCH_WINNERS_CTE=`winners AS MATERIALIZED (SELECT DISTINCT ON (host) id FROM (
 SELECT o.id,o.created_at,CASE WHEN o.payload->>'kind' IS DISTINCT FROM 'discovery-v1' THEN 0 WHEN EXISTS(SELECT 1 FROM sourcing_qualification_runs q WHERE q.workspace_id=o.workspace_id AND q.candidate_id=o.id) THEN 1 ELSE 2 END AS rank,
  regexp_replace(regexp_replace(lower(substring(btrim(CASE WHEN o.payload->>'kind'='discovery-v1' THEN o.payload->'row'->>'website' ELSE o.payload->>'website' END) from '^[A-Za-z]+://([^/?#:@]+)')),'[.]$',''),'^www[.]','') AS host
 FROM sourcing_candidates o WHERE o.workspace_id=$1 AND o.status<>'dismissed' AND (
  (o.payload->>'kind' IS DISTINCT FROM 'discovery-v1' AND (o.status='kept' OR o.payload->>'preparedBy'='Tavily Basic search · not verified'))
  OR (o.payload->>'kind'='discovery-v1' AND (EXISTS(SELECT 1 FROM sourcing_qualification_runs q WHERE q.workspace_id=o.workspace_id AND q.candidate_id=o.id) OR ${discoveryResearchEligibleSql('o')})))
) hosts WHERE host IS NOT NULL ORDER BY host,rank,created_at,id)`;
const originValue=(row:OriginRow):DiscoveryOrigin=>discoveryOriginSchema.parse({source:row.source,sourceMetadata:row.source_metadata,licenses:row.licenses,notices:row.notices});
const rowIdentity=(row:Payload['row'])=>canonical({firmName:row.firmName,website:row.website,locality:row.locality,region:row.region,probableGroupKey:row.probableGroupKey});
const originSelect=`SELECT candidate_id,source,source_metadata,licenses,notices FROM sourcing_candidate_discovery_origins WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY provider,release,record_id`;

/** Caller owns the transaction, as normal route commands do. Workspace lock precedes
 * candidate locks and immutable origin reads. No providers or routine jobs are created. */
export async function saveDiscoveryCandidate(ctx:RepositoryContext,input:DiscoveryIntakeSaveInput):Promise<Result<Saved>> {
 if(!decideAdminOnly(ctx).permitted)return refused('admin_only');
 const parsed=discoveryIntakeSaveInputSchema.safeParse(input);if(!parsed.success)return refused('invalid_input');
 const value=parsed.data,w=ctx.scope.workspaceId;
 await lockPreparationCleanup(ctx);
 // This bounded local serialization also protects secondary observation uniqueness
 // and opposite-direction attachments without relying on mutable JSON identity.
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-intake:${w}`]);
 const wanted=value.origins.map(origin=>({provider:origin.source.provider,release:origin.source.release,record_id:origin.source.recordId}));
 const existing=(await ctx.db.query<OriginRow>(`SELECT o.candidate_id,o.source,o.source_metadata,o.licenses,o.notices FROM sourcing_candidate_discovery_origins o JOIN jsonb_to_recordset($2::jsonb) AS wanted(provider text,release text,record_id text) ON o.provider=wanted.provider AND o.release=wanted.release AND o.record_id=wanted.record_id WHERE o.workspace_id=$1`,[w,JSON.stringify(wanted)])).rows;
 for(const origin of value.origins){const prior=existing.find(row=>discoverySourceKey(originValue(row).source)===discoverySourceKey(origin.source));if(prior&&canonical(originValue(prior))!==canonical(origin))return refused('source_conflict');}
 const candidateIds=new Set(existing.map(row=>row.candidate_id));
 if(candidateIds.size>1)return refused('source_identity_conflict');
 const existingId=existing[0]?.candidate_id;
 if(value.attachTo&&existingId&&value.attachTo.candidateId!==existingId)return refused('source_identity_conflict');
 const id=value.attachTo?.candidateId??existingId??randomUUID();
 const candidate=(await ctx.db.query<CandidateRow>('SELECT id,payload,status,revision,created_at FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,id])).rows[0];
 if((value.attachTo||existingId)&&!candidate)return refused('not_found');
 if(value.attachTo&&candidate?.revision!==value.attachTo.expectedRevision)return refused('candidate_changed');
 const priorPayload=candidate?discoveryCandidatePayloadSchema.safeParse(candidate.payload):null;
 if(candidate&&(!priorPayload?.success||candidate.status==='kept'))return refused('candidate_format_not_supported');
 if(priorPayload?.success&&rowIdentity(priorPayload.data.row)!==rowIdentity(value.row))return refused('candidate_identity_conflict');
 const priorOrigins=candidate?(await ctx.db.query<OriginRow>(originSelect,[w,id])).rows.map(originValue):[];
 // Replays cannot replace source confidence, labels or source metadata on a tuple.
 if(priorPayload?.success&&discoverySourceKey(priorPayload.data.row.source)===discoverySourceKey(value.row.source)){
  const primary=priorPayload.data.row;
  if(canonical(primary.source)!==canonical(value.row.source)||primary.sourceConfidence!==value.row.sourceConfidence)return refused('source_conflict');
 }
 const observations=new Map<string,Payload['row']['source']>();
 for(const source of [...(priorPayload?.success?priorPayload.data.row.observations:[]),...value.row.observations]){
  const key=discoverySourceKey(source),prior=observations.get(key);if(prior&&canonical(prior)!==canonical(source))return refused('source_conflict');observations.set(key,source);
 }
 const mergedOrigins=new Map(priorOrigins.map(origin=>[discoverySourceKey(origin.source),origin]));
 for(const origin of value.origins){const key=discoverySourceKey(origin.source),prior=mergedOrigins.get(key);if(prior&&canonical(prior)!==canonical(origin))return refused('source_conflict');mergedOrigins.set(key,origin);}
 if(observations.size>16||mergedOrigins.size>16)return refused('origin_limit');
 const merged={kind:'discovery-v1' as const,row:{...(priorPayload?.success?priorPayload.data.row:value.row),observations:[...observations.values()]}};
 if(!discoveryCandidatePayloadSchema.safeParse(merged).success)return refused('candidate_payload_too_large');
 // PostgreSQL jsonb adds formatting whitespace. Conserve its independent byte bound
 // before any candidate/origin write, not after a partially attached observation.
 const bounds=(await ctx.db.query<{payload_bytes:number;metadata_bytes:number;source_bytes:number;license_bytes:number;notice_bytes:number}>(`SELECT octet_length(($1::jsonb)::text) AS payload_bytes,COALESCE(max(octet_length((o->'sourceMetadata')::text)),0) AS metadata_bytes,COALESCE(max(octet_length((o->'source')::text)),0) AS source_bytes,COALESCE(max(octet_length((o->'licenses')::text)),0) AS license_bytes,COALESCE(max(octet_length((o->'notices')::text)),0) AS notice_bytes FROM jsonb_array_elements($2::jsonb) o`,[JSON.stringify(merged),JSON.stringify([...mergedOrigins.values()])])).rows[0];
 if(!bounds||bounds.payload_bytes>20000)return refused('candidate_payload_too_large');
 if(bounds.metadata_bytes>8192||bounds.source_bytes>8192||bounds.license_bytes>8192||bounds.notice_bytes>32768)return refused('origin_payload_too_large');
 const additions=value.origins.filter(origin=>!priorOrigins.some(prior=>discoverySourceKey(prior.source)===discoverySourceKey(origin.source)));
 if(candidate&&additions.length>0&&!value.attachTo)return refused('attachment_requires_revision');
 if(candidate&&additions.length===0)return {ok:true,value:{id,revision:candidate.revision,exactDuplicates:value.origins.length,observationsAttached:0,newlyPersisted:0}};
 if(candidate&&candidate.status==='dismissed')return refused('candidate_dismissed');
 let revision=candidate?.revision??1;
 if(!candidate){const key=createHash('sha256').update(JSON.stringify(['discovery-v1',value.row.source.provider,value.row.source.release,value.row.source.recordId])).digest('hex');await ctx.db.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[w,id,key,JSON.stringify(merged)]);}
 else{await ctx.db.query('UPDATE sourcing_candidates SET payload=$3::jsonb,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[w,id,JSON.stringify(merged)]);revision++;}
 for(const origin of additions)await ctx.db.query(`INSERT INTO sourcing_candidate_discovery_origins(workspace_id,candidate_id,provider,release,record_id,source,source_metadata,licenses,notices) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)`,[w,id,origin.source.provider,origin.source.release,origin.source.recordId,JSON.stringify(origin.source),JSON.stringify(origin.sourceMetadata),JSON.stringify(origin.licenses),JSON.stringify(origin.notices)]);
 await recordCrmAuditEvent(ctx,{action:'sourcing.discovery_candidate_saved',subjectKind:'sourcing_candidate',subjectId:id,detail:{revision,observationsAttached:additions.length,newlyPersisted:candidate?0:1}});
 return {ok:true,value:{id,revision,exactDuplicates:value.origins.length-additions.length,observationsAttached:additions.length,newlyPersisted:candidate?0:1}};
}

export async function listDiscoveryCandidates(ctx:RepositoryContext,input:z.infer<typeof discoveryIntakeListInputSchema>):Promise<Result<z.infer<typeof discoveryIntakeListSchema>>> {
 if(!decideAdminOnly(ctx).permitted)return refused('admin_only');
 const parsed=discoveryIntakeListInputSchema.safeParse(input);if(!parsed.success)return refused('invalid_input');
 const w=ctx.scope.workspaceId;
 // One statement snapshot binds each revision/observation set to its origins,
 // including when another command attaches or deletes immediately after this read.
 const rows=(await ctx.db.query<CandidateRow & {origins:unknown}>(`SELECT c.id,c.payload,c.status,c.revision,c.created_at,
  (SELECT jsonb_agg(jsonb_build_object('source',o.source,'sourceMetadata',o.source_metadata,'licenses',o.licenses,'notices',o.notices) ORDER BY o.provider,o.release,o.record_id)
   FROM sourcing_candidate_discovery_origins o WHERE o.workspace_id=c.workspace_id AND o.candidate_id=c.id) AS origins
  FROM sourcing_candidates c WHERE c.workspace_id=$1 AND c.status=$2 AND c.payload->>'kind'='discovery-v1' ORDER BY c.created_at DESC,c.id DESC LIMIT 51 OFFSET $3`,[w,parsed.data.status,parsed.data.offset])).rows;
 const candidates=rows.slice(0,50).map(row=>({id:row.id,status:row.status,revision:row.revision,createdAt:row.created_at.toISOString(),payload:row.payload,origins:row.origins}));
 return {ok:true,value:discoveryIntakeListSchema.parse({candidates,hasMore:rows.length>50})};
}
