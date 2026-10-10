import {z} from 'zod';
/** Metadata only: never accept DOM, URLs, names, content or exception messages. */
export const socialDiagnosticStageSchema=z.enum(['browser_load','claim','identity','composer','text','schedule','media','marker','submit','inspection','cancellation','preparation']);
export const socialDiagnosticReasonSchema=z.enum(['browser_unavailable','load_timeout','operation_timeout','session_changed','account_busy','schedule_missed','account_identity_changed','claim_expired','approval_changed','existing_draft','layout_changed','time_menu_unavailable','content_mismatch','schedule_mismatch','staged_content_changed','baseline_unverified','media_editor_unavailable','image_identity_unverified','format_not_verified','staging_unavailable','preparation_unavailable','unknown']);
export const socialDiagnosticEventSchema=z.strictObject({stage:socialDiagnosticStageSchema,outcome:z.enum(['started','succeeded','refused','unknown']),reason:socialDiagnosticReasonSchema.nullable(),at:z.string().datetime()});
export const socialDiagnosticAttemptSchema=z.strictObject({postId:z.string().uuid(),accountId:z.string().uuid(),revision:z.number().int().positive(),events:z.array(socialDiagnosticEventSchema).max(32)});
export type SocialDiagnosticEvent=z.infer<typeof socialDiagnosticEventSchema>;
export type SocialDiagnosticAttempt=z.infer<typeof socialDiagnosticAttemptSchema>;
export type SocialDiagnosticReporter=(stage:SocialDiagnosticEvent['stage'],outcome:SocialDiagnosticEvent['outcome'],reason?:string)=>void;
/** Unknown/exception strings collapse to one category rather than leaking page data. */
export function socialDiagnosticReason(reason:string|undefined):SocialDiagnosticEvent['reason']{if(reason===undefined)return null;const parsed=socialDiagnosticReasonSchema.safeParse(reason);return parsed.success?parsed.data:'unknown';}
export type SocialDeliveryStatus={queue:'unread'|'available'|'unavailable';lastReadAt:string|null;diagnostics?:SocialDiagnosticAttempt[]|undefined};
export interface SocialPreparationResult{ready:boolean;reason:string|null;events:SocialDiagnosticEvent[]}
