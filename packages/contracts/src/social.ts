import {z} from 'zod';
import {uuid} from './foundationRows.ts';
export const socialPlatformSchema=z.enum(['linkedin','facebook','x']);
export const socialAssetOriginSchema=z.strictObject({kind:z.enum(['upload','phone','web','screenshot']),sourceUrl:z.string().url().max(2048).refine(v=>new URL(v).protocol==='https:','HTTPS required').nullable(),usageNote:z.string().trim().max(1000).nullable()});
export const registerSocialAssetSchema=z.strictObject({assetId:uuid.optional(),expectedVersion:z.number().int().positive().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/u),bytes:z.number().int().positive().max(20*1024*1024),mime:z.enum(['image/png','image/jpeg','image/webp','image/heic']),origin:socialAssetOriginSchema,width:z.number().int().positive().max(4096).optional(),height:z.number().int().positive().max(4096).optional()}).refine(v=>v.assetId===undefined?v.expectedVersion===undefined:v.expectedVersion!==undefined&&v.width!==undefined&&v.height!==undefined&&v.bytes<=5*1024*1024&&['image/png','image/jpeg'].includes(v.mime),'Invalid derivative');
export type RegisterSocialAsset=z.infer<typeof registerSocialAssetSchema>;
export type AssetOrigin=z.infer<typeof socialAssetOriginSchema>;
export interface SocialAssetView{id:string;state:'uploading'|'ready'|'deleted';version:number;origin:AssetOrigin;objects:{version:number;kind:'original'|'derivative';state:'uploading'|'ready'|'deleted';sha256:string;bytes:number;mime:string;width:number|null;height:number|null}[]}

import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
export const socialAssetRegisterCommandSchema=registerSocialAssetSchema.safeExtend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialAssetCompleteCommandSchema=z.strictObject({assetId:uuid,uploadId:uuid,commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const socialAssetDeleteCommandSchema=z.strictObject({assetId:uuid,commandId:commandIdSchema,clientVersion:semanticVersionSchema});
