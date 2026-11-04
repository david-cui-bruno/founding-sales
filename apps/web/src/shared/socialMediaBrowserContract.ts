import {z} from 'zod';
import {uuid,instant,socialAssetRegisterCommandSchema,socialAssetDeleteCommandSchema,socialMediaCompleteCommandSchema,socialMediaApproveCommandSchema,socialMediaWithdrawCommandSchema,socialMediaPreviewInputSchema} from '@fss/contracts';
import {socialMediaReceiptInputSchema} from '@fss/contracts';
import {socialCommandResult} from './socialBrowserContract.ts';
const binding={assetId:uuid,version:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/u)};
export const socialMediaPoolItemSchema=z.strictObject({...binding,approvalRevision:z.number().int().nonnegative(),caption:z.string().max(1000),topic:z.string().max(200),altText:z.string().max(1000),width:z.number().int().positive().max(4096),height:z.number().int().positive().max(4096),mime:z.enum(['image/jpeg','image/png']),approved:z.boolean()});
export const socialMediaListSchema=z.strictObject({media:z.array(socialMediaPoolItemSchema).max(100)});
export const socialMediaSignedPreviewSchema=z.strictObject({url:z.url(),expiresAt:instant});
export const socialMediaUploadUrlSchema=socialMediaSignedPreviewSchema.extend({headers:z.record(z.string(),z.string().max(1000))});
export const socialMediaReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('unknown')}),
 z.strictObject({state:z.literal('refused'),reason:z.string().regex(/^[a-z_]{1,100}$/u)}),
 z.strictObject({state:z.literal('accepted'),result:z.union([
  z.strictObject({assetId:uuid,uploadId:uuid}),z.strictObject(binding),
  z.strictObject({...binding,approvalRevision:z.number().int().positive()}),
  z.strictObject({assetId:uuid,approvalRevision:z.number().int().nonnegative()}),z.strictObject({assetId:uuid}),
 ])}),
]);
export const socialMediaRequests:Readonly<Record<string,z.ZodType>>={
 '/social/media/list':z.strictObject({}),'/social/media/preview':socialMediaPreviewInputSchema,
 '/social/assets/register':socialAssetRegisterCommandSchema,'/social/assets/delete':socialAssetDeleteCommandSchema,
 '/social/media/receipt':socialMediaReceiptInputSchema,
 '/social/assets/upload-url':z.strictObject({assetId:uuid,uploadId:uuid}),
 '/social/media/complete':socialMediaCompleteCommandSchema,'/social/media/approve':socialMediaApproveCommandSchema,'/social/media/withdraw':socialMediaWithdrawCommandSchema,
};
export const socialMediaResponses:Readonly<Record<string,z.ZodType>>={
 '/social/media/list':socialMediaListSchema,'/social/media/preview':socialMediaSignedPreviewSchema,
 '/social/assets/upload-url':socialMediaUploadUrlSchema,
 '/social/assets/register':socialCommandResult(z.strictObject({assetId:uuid,uploadId:uuid})),
 '/social/media/receipt':socialMediaReceiptSchema,
 '/social/assets/delete':socialCommandResult(z.strictObject({assetId:uuid})),
 '/social/media/complete':socialCommandResult(z.strictObject(binding)),
 '/social/media/approve':socialCommandResult(z.strictObject({...binding,approvalRevision:z.number().int().positive()})),
 '/social/media/withdraw':socialCommandResult(z.strictObject({assetId:uuid,approvalRevision:z.number().int().nonnegative()})),
};
