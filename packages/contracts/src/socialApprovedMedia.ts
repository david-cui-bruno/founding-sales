import {z} from 'zod';
import {uuid} from './foundationRows.ts';
const binding={assetId:uuid,version:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)};
const command={commandId:z.string().min(1).max(128),clientVersion:z.string().min(1).max(40)};
export const socialMediaCompleteCommandSchema=z.strictObject({...command,assetId:uuid,uploadId:uuid});
export const socialMediaApproveInputSchema=z.strictObject({...binding,expectedApprovalRevision:z.number().int().nonnegative(),caption:z.string().trim().min(1).max(1000),topic:z.string().trim().min(1).max(200),altText:z.string().trim().min(1).max(1000),publicUseClearance:z.literal(true)});
export const socialMediaApproveCommandSchema=socialMediaApproveInputSchema.extend(command);
export const socialMediaWithdrawCommandSchema=z.strictObject({...command,assetId:uuid,expectedApprovalRevision:z.number().int().nonnegative()});
export const socialMediaPreviewInputSchema=z.strictObject(binding);
export type SocialMediaApprovalInput=z.infer<typeof socialMediaApproveInputSchema>;
export interface ApprovedSocialMedia {assetId:string;version:number;sha256:string;approvalRevision:number;caption:string;topic:string;altText:string;width:number;height:number;mime:'image/jpeg'|'image/png'}
export const socialMediaReceiptInputSchema=z.strictObject({kind:z.enum(['register','complete','approve','withdraw','delete']),commandId:z.string().min(1).max(128),payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
