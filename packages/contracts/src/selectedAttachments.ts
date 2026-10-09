import {canonicalSourceReferenceSchema} from './people.ts';
import {z} from 'zod';
import {selectedImportInputSchema,selectedImportResultSchema} from './selectedImports.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {crmSourceLookupSchema,crmProcessingResultSchema,crmProcessingHealthSchema,crmExtractionGenerationSchema} from './crmProcessing.ts';
export const selectedAttachmentFileSchema=z.object({fileName:z.string().min(1).max(240),declaredByteLength:z.number().int().min(0).max(100000000),bytesBase64:z.string().max(106668),completeness:z.enum(['complete','partial'])}).strict();
export const SELECTED_ATTACHMENT_FORMATS=['utf8_text','utf8_markdown','utf8_csv','utf8_srt','utf8_vtt'] as const;
export const selectedAttachmentSupportedPreviewSchema=z.object({state:z.literal('supported'),fileName:z.string().max(240),byteLength:z.number().int().positive().max(80000),fileHash:z.string().regex(/^[a-f0-9]{64}$/u),sourceContentHash:z.string().regex(/^[a-f0-9]{64}$/u),format:z.enum(SELECTED_ATTACHMENT_FORMATS),origin:z.literal('user_selected_original'),completeness:z.literal('complete'),processing:z.literal('not_requested'),previewHash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const selectedAttachmentUnavailablePreviewSchema=z.object({state:z.literal('unsupported'),reason:z.enum(['unsupported_format','incomplete_selection','unreadable_text','selection_limit_exceeded','empty_selection']),processing:z.literal('unavailable'),supportedFormats:z.array(z.enum(SELECTED_ATTACHMENT_FORMATS)),maxBytes:z.literal(80000),maxCharacters:z.literal(20000)}).strict();
export const selectedAttachmentPreviewSchema=z.union([selectedAttachmentSupportedPreviewSchema,selectedAttachmentUnavailablePreviewSchema]);
export const selectedAttachmentCommitPayloadSchema=selectedImportInputSchema.pick({participants:true,occurredAt:true}).extend({file:selectedAttachmentFileSchema,personId:z.uuid().nullable(),firmId:z.uuid().nullable(),importKey:z.string().min(1).max(140),previewHash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict().refine(value=>(value.personId===null)!==(value.firmId===null));
export const selectedAttachmentCommitSchema=selectedAttachmentCommitPayloadSchema.safeExtend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const selectedAttachmentReadSchema=z.object({sourceId:z.uuid()}).strict();
export const selectedAttachmentAnalyzePayloadSchema=z.object({source:crmSourceLookupSchema.refine(value=>value.kind==='selected_note'&&value.locator===null),fileHash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const selectedAttachmentAnalyzeSchema=selectedAttachmentAnalyzePayloadSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const selectedAttachmentReselectPayloadSchema=selectedImportInputSchema.pick({participants:true,occurredAt:true}).extend({file:selectedAttachmentFileSchema,sourceId:z.uuid(),expectedSourceRevision:z.number().int().positive(),expectedMetadataRevision:z.number().int().positive(),previewHash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
export const selectedAttachmentReselectSchema=selectedAttachmentReselectPayloadSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});

export const selectedAttachmentPageSchema=z.object({
 file:z.object({state:z.enum(['selected','stale','deleted','awaiting_selection']),sourceRevision:z.number().int().positive(),metadataRevision:z.number().int().positive(),fileName:z.string().min(1).max(240).nullable(),byteLength:z.number().int().positive().max(80000).nullable(),fileHash:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),format:z.enum(SELECTED_ATTACHMENT_FORMATS).nullable(),origin:z.literal('user_selected_original').nullable()}).strict(),
 source:canonicalSourceReferenceSchema,
 processing:z.union([crmProcessingResultSchema,z.object({state:z.literal('source_unavailable'),reason:z.enum(['source_deleted','source_unavailable'])}).strict()]),
 processingHealth:crmProcessingHealthSchema.optional(),
}).strict();

/** A selected-file commit returns versioned identity only, never file bytes. */
export const selectedAttachmentCommitResultSchema=selectedImportResultSchema;

export const selectedAttachmentAnalyzeResultSchema=crmExtractionGenerationSchema.pick({generationId:true,state:true,reason:true}).extend({sourceId:z.uuid(),sourceRevision:z.number().int().positive()}).strict();

export const selectedAttachmentReselectResultSchema=selectedImportResultSchema;
