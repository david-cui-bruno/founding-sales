import {z} from 'zod';
import {instant,uuid} from './foundationRows.ts';
import {manualProspectSchema} from './manualProspects.ts';
const positive=z.number().int().positive();
export const preparedProspectTargetSchema=z.strictObject({candidateId:uuid,candidateRevision:positive,runId:uuid.nullable()});
const passage=z.strictObject({kind:z.enum(['business','location','workflow','person','contact','contrary']),
 observationId:uuid,blockId:z.string().min(1).max(80),url:z.string().url().max(2000),retrievedAt:instant,quote:z.string().min(1).max(2000)});
export const preparedProspectPassageSchema=passage.extend({sourceCoverage:z.enum(['complete_page','partial_page'])});
/** Research readiness from retained own-site passages (ADR0034); never contact permission. */
export const preparedProspectCallableSchema=z.strictObject({state:z.enum(['callable','not_callable']),
 missing:z.array(z.enum(['needs_research','contrary_context','no_business_context','no_published_phone','list_page','not_company_page'])).max(6),
 phone:z.string().min(1).max(200).nullable(),person:z.string().min(1).max(200).nullable(),residential:z.boolean()})
 .refine(v=>new Set(v.missing).size===v.missing.length&&(v.state==='callable')===(v.missing.length===0)&&(v.state!=='callable'||v.phone!==null),'Callable requires a published phone and no missing condition');
export const preparedProspectSummarySchema=z.strictObject({target:preparedProspectTargetSchema,displayName:z.string().min(1).max(300),
 discoveryLabel:z.string().min(1).max(300),website:z.string().url().max(2000).nullable(),
 targetingLocality:z.string().max(300),targetingRegion:z.string().max(10),
 sourceNotices:manualProspectSchema.shape.sourceNotices.default([]),
 state:z.enum(['prepared','needs_research']),summary:z.string().min(1).max(400),
 unknowns:z.array(z.string().min(1).max(240)).max(12),validUntil:instant.nullable(),callable:preparedProspectCallableSchema,
 // ADR0034 company host (lowercase hostname without www.) of the website; grouping, never identity.
 companyHost:z.string().min(1).max(253).regex(/^[a-z0-9.:[\]-]+$/u).nullable()});
export const preparedProspectListInputSchema=z.strictObject({offset:z.number().int().min(0).max(1000000).default(0),viewRevision:z.string().regex(/^[a-f0-9]{64}$/u).optional(),
 order:z.enum(['priority','newest']).default('priority')})
 .refine(v=>v.offset===0||v.viewRevision!==undefined,'Continuation requires the current view revision');
export const preparedProspectListSchema=z.strictObject({prospects:z.array(preparedProspectSummarySchema).max(50),hasMore:z.boolean(),viewRevision:z.string().regex(/^[a-f0-9]{64}$/u),checkedAt:instant});
export const preparedProspectReadInputSchema=preparedProspectTargetSchema;
const detail={checkedAt:instant,nextAction:z.string().min(1).max(300),contactAuthority:z.literal('not_granted')};
// V1 only ever displayed complete pages. Keep rolling clients able to read that
// response without allowing V2 partial passages to claim complete coverage.
const legacyBrief=preparedProspectSummarySchema.omit({callable:true,companyHost:true}).extend({...detail,policyVersion:z.literal('prepared-prospect-v1'),
 passages:z.array(passage.extend({sourceCoverage:z.literal('complete_page').default('complete_page')})).max(16),
 coverage:z.enum(['complete_retained_pages','no_usable_retained_pages'])});
const currentBrief=preparedProspectSummarySchema.extend({...detail,policyVersion:z.literal('prepared-prospect-v2'),
 passages:z.array(preparedProspectPassageSchema).max(16),coverage:z.enum(['complete_retained_pages','partial_retained_pages','no_usable_retained_pages'])})
 .refine(v=>!v.passages.some(p=>p.sourceCoverage==='partial_page')||v.coverage==='partial_retained_pages','Partial passages require partial coverage');
export const preparedProspectBriefSchema=z.discriminatedUnion('policyVersion',[legacyBrief,currentBrief]);
export type PreparedProspectTarget=z.infer<typeof preparedProspectTargetSchema>;
export type PreparedProspectSummary=z.infer<typeof preparedProspectSummarySchema>;
export type PreparedProspectBrief=z.infer<typeof preparedProspectBriefSchema>;
export type PreparedProspectCurrentBrief=Extract<PreparedProspectBrief,{policyVersion:'prepared-prospect-v2'}>;
export type PreparedProspectCallable=z.infer<typeof preparedProspectCallableSchema>;
export const preparedProspectRefusalSchema=z.strictObject({error:z.enum(['view_changed','candidate_changed','candidate_unavailable','source_changed','source_expired'])});
export const preparedProspectListResponseSchema=z.union([preparedProspectListSchema,preparedProspectRefusalSchema]);
export const preparedProspectReadResponseSchema=z.union([preparedProspectBriefSchema,preparedProspectRefusalSchema]);
