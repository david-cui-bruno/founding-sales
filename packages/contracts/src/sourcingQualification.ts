import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';
import { sourcingUrlSchema } from './sourcing.ts';

export const qualificationStatusSchema = z.enum(['pending','running','review','eligible','admitted','unavailable']);
export const qualificationRequestSchema = z.strictObject({candidateId:uuid,expectedRevision:z.number().int().positive()});
const blockId = z.string().min(1).max(80);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceObservationSchema = z.strictObject({
  id:uuid,url:sourcingUrlSchema,contentHash:digest,relevantTextHash:digest,retrievedAt:instant,
  publishedAt:instant.nullable(),publishedAtBlockId:blockId.nullable(),firstParty:z.boolean(),truncated:z.boolean(),
  blocks:z.array(z.strictObject({id:blockId,text:z.string().min(1).max(4000)})).min(1).max(32),
}).superRefine((value,ctx)=>{
  if(new Set(value.blocks.map(block=>block.id)).size!==value.blocks.length)
    ctx.addIssue({code:'custom',message:'Block identities must be unique.'});
  if((value.publishedAt===null)!==(value.publishedAtBlockId===null) ||
    (value.publishedAtBlockId!==null && !value.blocks.some(block=>block.id===value.publishedAtBlockId)))
    ctx.addIssue({code:'custom',message:'A publication date requires its supporting source block.'});
});
export const qualificationFactSchema = z.strictObject({
  kind:z.enum(['firm_identity','residential_management','service_area','business_phone','help_request','operational_burden','coordination_job','growth','tool_gap','existing_support']),
  value:z.string().trim().min(1).max(2000),observationId:uuid,blockId,
});
export const qualificationVerdictSchema = z.strictObject({
  decision:z.enum(['eligible','review']),rank:z.enum(['help_request','operational_burden','investigation','fit_only']),
  reasons:z.array(z.string().min(1).max(120)).max(30),evidenceIds:z.array(uuid).max(30),
  unknowns:z.array(z.string().min(1).max(120)).max(30),policyVersion:z.string().min(1).max(80),
});
export const qualificationEvidenceSchema = z.strictObject({
  observations:z.array(sourceObservationSchema).max(8),facts:z.array(qualificationFactSchema).max(30),
}).superRefine((value,ctx)=>{
  const fold=(text:string)=>text.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
  if(new Set(value.observations.map(source=>source.id)).size!==value.observations.length)
    ctx.addIssue({code:'custom',message:'Observation identities must be unique.'});
  for(const fact of value.facts){
    const source=value.observations.find(item=>item.id===fact.observationId);
    const block=source?.blocks.find(item=>item.id===fact.blockId);
    if(!block || !fold(block.text).includes(fold(fact.value)))
      ctx.addIssue({code:'custom',message:'Each fact must be grounded in its referenced source text.'});
  }
});
export type SourceObservation = z.infer<typeof sourceObservationSchema>;
export type QualificationFact = z.infer<typeof qualificationFactSchema>;
export type QualificationVerdict = z.infer<typeof qualificationVerdictSchema>;
export type QualificationStatus = z.infer<typeof qualificationStatusSchema>;
export interface QualificationView {
  candidateId:string;runId:string;candidateRevision:number;status:QualificationStatus;reason:string|null;
  requestedAt:string;deadlineAt:string;observations:SourceObservation[];facts:QualificationFact[];
  verdict:QualificationVerdict|null;openingQuestion:string|null;
  admission:{firmId:string;routeId:string}|null;
  history:{runId:string;observations:SourceObservation[];facts:QualificationFact[]}[];
}
