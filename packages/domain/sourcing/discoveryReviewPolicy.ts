import {createHash} from 'node:crypto';
import {discoveryReviewSchema,type DiscoveryReviewInput,type discoveryPriorityBandSchema} from '@fss/contracts';
import type {z} from 'zod';

export type DiscoveryReview=z.infer<typeof discoveryReviewSchema>;
export type DiscoveryPriorityBand=z.infer<typeof discoveryPriorityBandSchema>;
export const DISCOVERY_REVIEW_HORIZON_MS=7*24*60*60*1000;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item:unknown)=>item!==null&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);

/** Collections are canonicalized, without normalizing any source identity or text. */
export function discoveryReviewContent(input:DiscoveryReviewInput):{evidence:DiscoveryReviewInput['evidence'];assessment:DiscoveryReviewInput['assessment'];digest:string} {
  const evidence=input.evidence.map(page=>({...page,blocks:[...page.blocks].sort((a,b)=>a.blockId.localeCompare(b.blockId))})).sort((a,b)=>canonical(a).localeCompare(canonical(b)));
  const assessment={...input.assessment,unknowns:[...new Set(input.assessment.unknowns)].sort()};
  const digest=createHash('sha256').update(canonical({reviewVersion:input.reviewVersion,evidence,assessment})).digest('hex');
  return {evidence,assessment,digest};
}

/** Human service interpretation only, never independently verified firm identity. */
export function discoveryPriority(review:DiscoveryReview|null):DiscoveryPriorityBand {
  if(!review||review.evidence.length===0||review.assessment.serviceSignal==='unknown')return 'unreviewed';
  if(review.assessment.serviceSignal==='contradicted')return 'contradicted';
  if(review.assessment.websiteAssociation==='ambiguous'||review.evidence.some(page=>page.association==='ambiguous'))return 'tentative';
  return review.assessment.serviceSignal==='paragraph_supported'&&review.evidence.some(page=>page.blocks.some(block=>block.kind==='paragraph'))?'review_first':'tentative';
}

export interface DiscoveryReviewRow extends Record<string,unknown> {
  id:string;candidate_id:string;candidate_revision:number;review_version:string;content_digest:string;
  evidence:unknown;assessment:unknown;reviewed_at:Date;
}
export function discoveryReviewValue(row:DiscoveryReviewRow):DiscoveryReview {
  return discoveryReviewSchema.parse({id:row.id,candidateId:row.candidate_id,candidateRevision:row.candidate_revision,reviewVersion:row.review_version,contentDigest:row.content_digest,evidence:row.evidence,assessment:row.assessment,reviewedAt:row.reviewed_at.toISOString()});
}
