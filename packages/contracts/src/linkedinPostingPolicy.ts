import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';

/** Settled #608 owner scope. This is not account, provider or Enable evidence. */
export const LINKEDIN_POSTING_RULES={
 version:'608-2026-10-13',platform:'linkedin',account:'david-cui-589a20228',accountKind:'personal_profile',format:'text_only',
 cadence:{days:['Tuesday','Thursday'],hour:10,zone:'America/New_York',weeklyMaximum:2,catchUpBurst:false,skipUnready:true,automaticIncrease:false},
 content:{topics:['real_founder_building_work','technical_tradeoffs','maintenance_grounded_in_actual_work','verified_news_and_technology'],inputs:'approved_sanitized_facts_and_build_updates_or_permitted_public_sources',provenanceRequired:true,plannedLocalShippedDistinct:true,news:'relevant_original_source_check_and_link',unsupported:'skip_or_owner_review',newPersonalPosition:'owner_review',sensitiveTopic:'owner_review',privateConversations:false,identifiableCustomerStories:false,confidentialCode:false,inventedResults:false,inventedPromises:false,inventedExpertise:false,inventedExperiences:false,inventedOpinions:false,inventedEndorsements:false,rejectedAutomationSampleApproved:false},
 voice:{style:'original_developed_spaced_out_actual_work',inspiration:'structure_only',copiedSentencesOrAnecdotes:false},
 generation:{provider:'bedrock',providerKey:'aws_bedrock.social_draft',model:'claude-haiku-4-5',data:'approved_sanitized_facts_and_permitted_public_source_material',silentRouteSwitch:false},
 spend:{dailyUsd:1,calendarMonthUsd:10,zone:'America/New_York',stricterSharedLimits:true,reserveDefensibleMaximumBeforeCall:true,unknownSettlement:'conservative',automaticIncrease:false,crossLanePooling:false,unboundedCost:'pause',exhausted:'skip_or_pause'},
 stops:{accountWarning:'pause_lane',staleAccountOrPolicy:'pause_lane',revocation:'invalidate_pending_candidates',uncertainSubmission:'inspect_never_replay',published:'cannot_unsend',questionableDraft:'skip_or_owner_review_no_replacement_burst'},
} as const;
export const linkedinPostingGenerationSchema=z.strictObject({
 provider:z.literal('bedrock'),providerKey:z.literal('aws_bedrock.social_draft'),model:z.literal('claude-haiku-4-5'),
 routeVersion:z.string().trim().min(1).max(200),accessGrantVersion:z.string().trim().min(1).max(200),dataHandlingVersion:z.string().trim().min(1).max(200),
 dailyUsd:z.literal(1),calendarMonthUsd:z.literal(10),budgetZone:z.literal('America/New_York'),
});
export const linkedinPostingPolicySaveSchema=z.strictObject({expectedRevision:z.number().int().nonnegative(),accountId:uuid,accountRevision:z.number().int().positive(),approvedRulesVersion:z.literal(LINKEDIN_POSTING_RULES.version),generation:linkedinPostingGenerationSchema.nullable()});
export type LinkedinPostingPolicySave=z.infer<typeof linkedinPostingPolicySaveSchema>;
export const linkedinPostingPolicySaveCommandSchema=linkedinPostingPolicySaveSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const linkedinPostingPolicyStopCommandSchema=z.strictObject({expectedRevision:z.number().int().positive(),commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const linkedinPostingPolicyCheckSchema=z.strictObject({expectedRevision:z.number().int().positive(),accountId:uuid,accountRevision:z.number().int().positive()});
export type LinkedinPostingPolicyCheck=z.infer<typeof linkedinPostingPolicyCheckSchema>;
export interface LinkedinPostingPolicyCurrent{current:boolean;allowed:false;revision:number;reason:string}
export const linkedinPostingCandidateBindSchema=z.strictObject({postId:uuid,postRevision:z.number().int().positive(),expectedRevision:z.number().int().positive()});
export const linkedinPostingCandidateBindCommandSchema=linkedinPostingCandidateBindSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export interface LinkedinPostingCandidateBinding{postId:string;postRevision:number;policyRevision:number;current:true;publicationReady:false}
export interface LinkedinPostingPolicySnapshot{accountId:string;accountRevision:number;accountExternalId:string;generation:LinkedinPostingPolicySave['generation'];rules:typeof LINKEDIN_POSTING_RULES}
export interface LinkedinPostingPolicyView{
 accounts:{id:string;externalId:string;displayName:string;revision:number;state:string}[];
 revision:number;state:'not_saved'|'saved'|'disabled'|'revoked';enabled:false;technicallyReady:false;
 policy:LinkedinPostingPolicySnapshot|null;rules:typeof LINKEDIN_POSTING_RULES;holds:string[];
 history:{revision:number;state:string;accountId:string;accountRevision:number;recordedAt:string}[];
 candidates:{postId:string;postRevision:number;policyRevision:number;current:boolean;reason:string;submissionState:string}[];
}
function sameRules(value:unknown,expected:unknown):boolean{
 if(expected===null||typeof expected!=='object')return value===expected;
 if(value===null||typeof value!=='object'||Array.isArray(value)!==Array.isArray(expected))return false;
 const a=value as Record<string,unknown>,b=expected as Record<string,unknown>;
 return Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(key=>sameRules(a[key],b[key]));
}
const rulesSchema=z.custom<typeof LINKEDIN_POSTING_RULES>(value=>sameRules(value,LINKEDIN_POSTING_RULES));
export const linkedinPostingPolicyViewSchema=z.strictObject({
 accounts:z.array(z.strictObject({id:uuid,externalId:z.string(),displayName:z.string(),revision:z.number().int().positive(),state:z.enum(['connected','disconnected','reconnect','unsupported'])})),
 revision:z.number().int().nonnegative(),state:z.enum(['not_saved','saved','disabled','revoked']),enabled:z.literal(false),technicallyReady:z.literal(false),rules:rulesSchema,
 policy:z.strictObject({accountId:uuid,accountRevision:z.number().int().positive(),accountExternalId:z.string(),generation:linkedinPostingGenerationSchema.nullable(),rules:rulesSchema}).nullable(),holds:z.array(z.string()),
 history:z.array(z.strictObject({revision:z.number().int().positive(),state:z.enum(['saved','disabled','revoked']),accountId:uuid,accountRevision:z.number().int().positive(),recordedAt:z.string().datetime()})),
 candidates:z.array(z.strictObject({postId:uuid,postRevision:z.number().int().positive(),policyRevision:z.number().int().positive(),current:z.boolean(),reason:z.string(),submissionState:z.string()})),
});
export const linkedinPostingCandidateBindingSchema=z.strictObject({postId:uuid,postRevision:z.number().int().positive(),policyRevision:z.number().int().positive(),current:z.literal(true),publicationReady:z.literal(false)});
export const linkedinPostingDispatchCheckSchema=z.strictObject({submissionId:uuid});
export const linkedinPostingDispatchCurrentSchema=z.strictObject({current:z.boolean(),reason:z.string()});
