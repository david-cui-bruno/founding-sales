import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';

/** #634 approvals are policy ceilings, not claims of provider/platform safety. */
export const LINKEDIN_OUTREACH_RULES = {
 version: '634-2026-10-13',
 invitations: {rolling24Hours:20,rolling7Days:140,includeManual:true,clock:'elapsed_rolling',window:{zone:'prospect_local',startHour:9,endHourExclusive:17,weekends:true,unknownTimezone:'postpone'},notes:'never',unknownRemainingAllowance:'hold'},
 directMessages: {rolling24Hours:20,includeManual:true,clock:'elapsed_rolling',window:{zone:'prospect_local',startHour:9,endHourExclusive:17,weekends:false,unknownTimezone:'postpone'},unknownRemainingAllowance:'hold'},
 cadence: {scope:'person_email_and_linkedin',maximumMessages:4,days:[0,3,7,14],includeManualProspecting:true,weekdayShift:'next_permitted_weekday',catchUpBurst:false,stricterEmailLimits:'independent'},
 firms: {activePeople:1,unansweredCooldownDays:30,cooldownStarts:'final_sequence_message',referral:'supported_only_without_contradicting_refusal'},
 stops: {anyReply:'stop_and_owner_handoff',personRefusal:'suppress_person',firmRefusal:'suppress_firm',ambiguousRefusal:'hold_firm',routineSubstantiveReplies:false,suppressionBypass:false,missingRelevantReplyHistory:'hold_person'},
 acquisition: {account:'existing_personal_linkedin_exact_identity_required',scope:'supported_property_manager_prospects_or_founder_sales_business_relationships',unrelatedPersonalChats:false,wholeInbox:false,manualCounting:'minimal_activity_without_unrelated_bodies'},
 retention: {until:'owner_deletes',stopCapture:'retain_permitted_copies_no_new_acquisition',processingAuthority:'separate',deletion:'erase_copied_and_derived_private_content_invalidate_source_work',retainedFacts:'minimal_content_free_stop_deletion_audit',providerOriginalDeletion:false,ordinaryReimport:false},
 generation: {model:'us.anthropic.claude-haiku-4-5-20251001-v1:0',purpose:'linkedin_prospecting_dm_openers_followups',data:'supported_person_firm_facts_and_message_relevant_permitted_excerpts',wholeInboxes:false,unrelatedChats:false,inventedFamiliarity:false,inferredPromises:false,substantiveSalesReplies:false,silentRouteSwitch:false},
 spend: {purpose:'linkedin_prospecting_dm_generation',dailyUsd:2,calendarMonthUsd:25,zone:'America/New_York',stricterSharedLimits:true,postingBookingDiagnosticPooling:false,reserveBeforeDispatch:true,failedUnknownSettlement:'conservative',insufficientAllowance:'pause',automaticTopUp:false},
 calibration: {requiredBeforeOperation:true,scope:'one_representative_original_opener_and_day3_day7_day14_set',perRecipientReview:false,openerPrefix:'Great connecting with you',question:'genuine_relevant',inventedFamiliarity:false,privateStoryReuse:false,newSubstantiveSalesCommitments:false},
} as const;

export const linkedinGenerationBindingSchema=z.strictObject({
 provider:z.literal('bedrock'),providerKey:z.string().trim().min(1).max(100),
 region:z.literal('us-east-1'),endpointId:z.literal('bedrock-runtime.us-east-1.amazonaws.com'),
 model:z.literal(LINKEDIN_OUTREACH_RULES.generation.model),
 accessGrantVersion:z.string().trim().min(1).max(200),dataHandlingVersion:z.string().trim().min(1).max(200),
 routeVersion:z.string().trim().min(1).max(200),
 dailyUsd:z.literal(2),calendarMonthUsd:z.literal(25),budgetZone:z.literal('America/New_York'),
});
export const linkedinPolicySaveSchema=z.strictObject({
 expectedRevision:z.number().int().nonnegative(),accountId:uuid,accountRevision:z.number().int().positive(),
 approved:z.literal(true),approvedRulesVersion:z.literal(LINKEDIN_OUTREACH_RULES.version),dataScope:z.literal('founder_sales_business').nullable(),
 acquisitionBinding:z.strictObject({configurationId:uuid,revision:z.number().int().positive()}).nullable(),
 generation:linkedinGenerationBindingSchema.nullable(),
});
export type LinkedinPolicySave=z.infer<typeof linkedinPolicySaveSchema>;
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const linkedinPolicySaveCommandSchema=linkedinPolicySaveSchema.extend(envelope);
export const linkedinPolicyStopCommandSchema=z.strictObject({expectedRevision:z.number().int().positive(),...envelope});
export const linkedinPolicyCheckSchema=z.strictObject({expectedRevision:z.number().int().positive(),accountId:uuid,accountRevision:z.number().int().positive()});
export type LinkedinPolicyCheck=z.infer<typeof linkedinPolicyCheckSchema>;
export const linkedinPolicyWorkBindingSchema=linkedinPolicyCheckSchema.extend({ownerUserId:uuid});
export type LinkedinPolicyWorkBinding=z.infer<typeof linkedinPolicyWorkBindingSchema>;
export interface LinkedinPolicySnapshot {
 accountId:string;accountRevision:number;accountExternalId:string;dataScope:LinkedinPolicySave['dataScope'];
 acquisitionBinding:LinkedinPolicySave['acquisitionBinding'];generation:LinkedinPolicySave['generation'];rules:typeof LINKEDIN_OUTREACH_RULES;
}
export type LinkedinPolicyHold='policy_not_saved'|'policy_rules_changed'|'owner_unavailable'|'owner_approval_required'|'policy_disabled'|'policy_revoked'|'account_changed'|'account_unavailable'|'exact_identity_unverified'|'data_scope_unknown'|'acquisition_binding_unknown'|'acquisition_evidence_unavailable'|'manual_count_coverage_unavailable'|'reply_history_coverage_unavailable'|'generation_not_configured'|'provider_binding_unverified'|'spend_evidence_unavailable'|'voice_calibration_unverified'|'outreach_adapter_unavailable';
export interface LinkedinPolicyAccount {id:string;externalId:string;displayName:string;revision:number;state:'connected'|'reconnect'|'unsupported'|'disconnected';identityVerified:false}
export interface LinkedinPolicyView {
 accounts:LinkedinPolicyAccount[];
 revision:number;state:'not_saved'|'saved'|'disabled'|'revoked';rules:typeof LINKEDIN_OUTREACH_RULES;enabled:false;technicallyReady:boolean;
 approved:boolean;approvedAt:string|null;policy:LinkedinPolicySnapshot|null;holds:LinkedinPolicyHold[];
}
export interface LinkedinPolicyCurrent {current:boolean;allowed:false;revision:number;reason:string;holds:LinkedinPolicyHold[]}
export interface LinkedinPolicyWorkCurrent extends LinkedinPolicyCurrent {policy:LinkedinPolicySnapshot|null}
