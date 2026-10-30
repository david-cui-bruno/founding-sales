import {z} from 'zod';
import {instant,uuid} from './foundationRows.ts';
import {manualProspectSchema} from './manualProspects.ts';
const positive=z.number().int().positive();
export const preparedProspectTargetSchema=z.strictObject({candidateId:uuid,candidateRevision:positive,runId:uuid.nullable()});
export const preparedProspectPassageSchema=z.strictObject({kind:z.enum(['business','location','workflow','person','contact','contrary']),
 observationId:uuid,blockId:z.string().min(1).max(80),url:z.string().url().max(2000),retrievedAt:instant,quote:z.string().min(1).max(2000)});
export const preparedProspectSummarySchema=z.strictObject({target:preparedProspectTargetSchema,displayName:z.string().min(1).max(300),
 discoveryLabel:z.string().min(1).max(300),website:z.string().url().max(2000).nullable(),
 targetingLocality:z.string().max(300),targetingRegion:z.string().max(10),
 sourceNotices:manualProspectSchema.shape.sourceNotices.default([]),
 state:z.enum(['prepared','needs_research']),summary:z.string().min(1).max(400),
 unknowns:z.array(z.string().min(1).max(240)).max(12),validUntil:instant.nullable()});
export const preparedProspectListInputSchema=z.strictObject({offset:z.number().int().min(0).max(1000000).default(0),viewRevision:z.string().regex(/^[a-f0-9]{64}$/u).optional()})
 .refine(v=>v.offset===0||v.viewRevision!==undefined,'Continuation requires the current view revision');
export const preparedProspectListSchema=z.strictObject({prospects:z.array(preparedProspectSummarySchema).max(50),hasMore:z.boolean(),viewRevision:z.string().regex(/^[a-f0-9]{64}$/u),checkedAt:instant});
export const preparedProspectReadInputSchema=preparedProspectTargetSchema;
export const preparedProspectBriefSchema=preparedProspectSummarySchema.extend({policyVersion:z.literal('prepared-prospect-v1'),checkedAt:instant,
 passages:z.array(preparedProspectPassageSchema).max(16),coverage:z.enum(['complete_retained_pages','no_usable_retained_pages']),
 nextAction:z.string().min(1).max(300),contactAuthority:z.literal('not_granted')});
export type PreparedProspectTarget=z.infer<typeof preparedProspectTargetSchema>;
export type PreparedProspectSummary=z.infer<typeof preparedProspectSummarySchema>;
export type PreparedProspectBrief=z.infer<typeof preparedProspectBriefSchema>;
export const preparedProspectRefusalSchema=z.strictObject({error:z.enum(['view_changed','candidate_changed','candidate_unavailable','source_changed','source_expired'])});
export const preparedProspectListResponseSchema=z.union([preparedProspectListSchema,preparedProspectRefusalSchema]);
export const preparedProspectReadResponseSchema=z.union([preparedProspectBriefSchema,preparedProspectRefusalSchema]);
