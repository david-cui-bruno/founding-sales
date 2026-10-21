import {createHash} from 'node:crypto';
import {candidateInputSchema,discoveryCandidatePayloadSchema,discoveryOriginSchema,discoveryPromotionInputSchema,discoveryPromotionSavedSchema,type DiscoveryPromotionInput,type CandidateInput} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {saveCandidate} from './candidates.ts';

type Prepared=z.infer<typeof discoveryPromotionSavedSchema>;
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
interface CandidateRow {id:string;revision:number;status:string;payload:unknown;[key:string]:unknown}
const refused=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item!==null&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);

/** No inference or normalization upgrades raw references into usable context. */
export function discoveryPreparationMatches(raw:unknown,input:CandidateInput):boolean {
 const parsed=discoveryCandidatePayloadSchema.safeParse(raw);
 if(!parsed.success)return false;
 const row=parsed.data.row;
 return row.firmName===input.firmName&&row.website===input.website&&row.locality===input.locality&&row.region===input.region;
}

/** Caller owns the ordinary command transaction. Preparation is a HUMAN seed only.
 * It does not Keep, enqueue research, mint observations, admit or contact anyone. */
export async function prepareDiscoveryCandidate(ctx:RepositoryContext,input:DiscoveryPromotionInput):Promise<Result<{promotionId:string;alreadyPrepared:boolean}>> {
 if(!decideAdminOnly(ctx).permitted)return refused('admin_only');
 const parsed=discoveryPromotionInputSchema.safeParse(input);if(!parsed.success)return refused('invalid_input');
 const value=parsed.data,w=ctx.scope.workspaceId;
 // Same ordering as discovery intake, then candidate, then the body-free link.
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-intake:${w}`]);
 const raw=(await ctx.db.query<CandidateRow>('SELECT id,payload,status,revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,value.discoveryCandidateId])).rows[0];
 if(!raw)return refused('not_found');
 if(raw.revision!==value.expectedRevision)return refused('candidate_changed');
 if(raw.status==='dismissed')return refused('candidate_dismissed');
 if(!discoveryPreparationMatches(raw.payload,value.candidate))return refused('discovery_context_mismatch');
 const origin=(await ctx.db.query<{source:unknown;source_metadata:unknown;licenses:unknown;notices:unknown}>(`SELECT source,source_metadata,licenses,notices FROM sourcing_candidate_discovery_origins WHERE workspace_id=$1 AND candidate_id=$2 AND provider=$3 AND release=$4 AND record_id=$5`,[w,raw.id,value.source.provider,value.source.release,value.source.recordId])).rows[0];
 const retained=origin?discoveryOriginSchema.safeParse({source:origin.source,sourceMetadata:origin.source_metadata,licenses:origin.licenses,notices:origin.notices}):null;
 if(!retained?.success)return refused('source_unavailable');
 const digest=createHash('sha256').update(canonical(value)).digest('hex');
 const previous=(await ctx.db.query<{id:string;input_digest:string}>('SELECT id,input_digest FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND raw_candidate_id=$2',[w,raw.id])).rows[0];
 if(previous){
  if(previous.input_digest!==digest)return refused('preparation_conflict');
  return await readDiscoveryPreparation(ctx,previous.id)?{ok:true,value:{promotionId:previous.id,alreadyPrepared:true}}:refused('preparation_unavailable');
 }
 const saved=await saveCandidate(ctx,value.candidate);if(!saved.ok)return saved;
 const legacy=(await ctx.db.query<CandidateRow>('SELECT id,payload,status,revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,saved.value.id])).rows[0];
 // Existing drafts are reused only when the full explicit seed agrees. Never
 // overwrite another human interpretation merely because identity keys collide.
 if(!legacy||legacy.status==='dismissed'||canonical(candidateInputSchema.parse(legacy.payload))!==canonical(value.candidate))return refused('legacy_candidate_conflict');
 const inserted=(await ctx.db.query<{id:string}>(`INSERT INTO sourcing_discovery_promotions(workspace_id,raw_candidate_id,raw_candidate_revision,legacy_candidate_id,legacy_candidate_revision,provider,release,record_id,input_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,[w,raw.id,raw.revision,legacy.id,legacy.revision,value.source.provider,value.source.release,value.source.recordId,digest])).rows[0];
 if(!inserted)throw new Error('Discovery preparation insert returned no identity');
 return {ok:true,value:{promotionId:inserted.id,alreadyPrepared:false}};
}

/** Receipt rehydration never serves historical copied seed text. One statement
 * snapshot checks both candidate lifecycles and exact surviving origin parent. */
export async function readDiscoveryPreparation(ctx:RepositoryContext,promotionId:string,alreadyPrepared=false):Promise<Prepared|null> {
 if(!decideAdminOnly(ctx).permitted)return null;
 const row=(await ctx.db.query<CandidateRow&{raw_id:string;raw_revision:number;raw_payload:unknown}>(`SELECT r.id AS raw_id,r.revision AS raw_revision,r.payload AS raw_payload,c.id,c.payload,c.status,c.revision FROM sourcing_discovery_promotions p JOIN sourcing_candidates r ON r.workspace_id=p.workspace_id AND r.id=p.raw_candidate_id AND r.revision=p.raw_candidate_revision AND r.status<>'dismissed' JOIN sourcing_candidates c ON c.workspace_id=p.workspace_id AND c.id=p.legacy_candidate_id AND c.status<>'dismissed' JOIN sourcing_candidate_discovery_origins o ON o.workspace_id=p.workspace_id AND o.candidate_id=r.id AND o.provider=p.provider AND o.release=p.release AND o.record_id=p.record_id WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.scope.workspaceId,promotionId])).rows[0];
 if(!row)return null;
 const candidate=candidateInputSchema.safeParse(row.payload);if(!candidate.success||!discoveryPreparationMatches(row.raw_payload,candidate.data))return null;
 return discoveryPromotionSavedSchema.parse({discoveryCandidateId:row.raw_id,discoveryRevision:row.raw_revision,qualificationCandidateId:row.id,alreadyPrepared,nextAction:'review_source_and_request_qualification',qualificationRequested:false,admissionAuthorized:false,runtimeCallable:false});
}

export async function readDiscoveryPreparationForCandidate(ctx:RepositoryContext,candidateId:string):Promise<Prepared|null> {
 if(!decideAdminOnly(ctx).permitted)return null;
 const row=(await ctx.db.query<{id:string}>('SELECT id FROM sourcing_discovery_promotions WHERE workspace_id=$1 AND raw_candidate_id=$2',[ctx.scope.workspaceId,candidateId])).rows[0];
 return row?readDiscoveryPreparation(ctx,row.id):null;
}
