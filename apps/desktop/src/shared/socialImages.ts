import {z} from 'zod';
const rect=z.strictObject({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive().max(4096),height:z.number().int().positive().max(4096)});
export const socialImageEditSchema=z.strictObject({id:z.string().uuid(),crop:rect.nullable(),redactions:z.array(rect).max(100)});
export const socialImageChooseSchema=z.strictObject({kind:z.enum(['upload','phone','screenshot']),usageNote:z.string().trim().max(1000).nullable()});
export const socialImageStageSchema=z.strictObject({id:z.string().uuid(),width:z.number().int().positive(),height:z.number().int().positive(),baseWidth:z.number().int().positive(),baseHeight:z.number().int().positive(),preview:z.string().max(700000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u),crop:rect.nullable(),redactions:z.array(rect).max(100),locked:z.boolean(),usageNote:z.string().nullable()});
export const socialImageImportViewSchema=z.strictObject({stage:socialImageStageSchema.nullable(),reason:z.string().nullable(),savedAssetId:z.string().uuid().nullable()});
export type SocialImageImportView=z.infer<typeof socialImageImportViewSchema>;
export type SocialImageEdit=z.infer<typeof socialImageEditSchema>;
export type SocialImageChoose=z.infer<typeof socialImageChooseSchema>;
