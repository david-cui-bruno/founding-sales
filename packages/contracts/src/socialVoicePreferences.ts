import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {instant,uuid} from './foundationRows.ts';

/** Explicit private style guidance only, never evidence, training or activation. */
export const socialVoicePreferenceSchema=z.strictObject({entryId:uuid,
 dimension:z.enum(['tone','formality','concision','structure','vocabulary','formatting','avoid']),
 guidance:z.string().min(1).max(500).refine(value=>value.trim().length>0,'Nonblank guidance required')
  .refine(value=>new TextEncoder().encode(value).byteLength<=2000,'Guidance exceeds byte limit'),
});
export const socialVoiceEntriesSchema=z.array(socialVoicePreferenceSchema).min(1).max(20)
 .refine(entries=>new Set(entries.map(entry=>entry.entryId)).size===entries.length,'Entry IDs must be unique')
 .refine(entries=>new TextEncoder().encode(JSON.stringify(entries)).byteLength<=10000,'Guide exceeds byte limit');
const identity={guideId:uuid,expectedRevision:z.number().int().positive()};
const create=z.strictObject({operation:z.literal('create'),entries:socialVoiceEntriesSchema});
const update=z.strictObject({operation:z.literal('update'),...identity,entries:socialVoiceEntriesSchema});
const remove=z.strictObject({operation:z.literal('remove'),...identity});
const restart=z.strictObject({operation:z.literal('restart'),...identity,entries:socialVoiceEntriesSchema});
export const socialVoiceSaveInputSchema=z.discriminatedUnion('operation',[create,update,remove,restart]);
const envelope={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const socialVoiceSaveCommandSchema=z.discriminatedUnion('operation',[
 create.extend(envelope),update.extend(envelope),remove.extend(envelope),restart.extend(envelope),
]);
export const socialVoiceReadInputSchema=z.strictObject({});
export const socialVoiceReceiptInputSchema=z.strictObject({commandId:commandIdSchema,
 payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
export const socialVoiceSavedSchema=z.strictObject({guideId:uuid,revision:z.number().int().positive()});
const metadata={guideId:uuid,revision:z.number().int().positive(),createdAt:instant,updatedAt:instant};
export const socialVoiceGuideSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('absent')}),
 z.strictObject({state:z.literal('available'),...metadata,entries:socialVoiceEntriesSchema}),
 z.strictObject({state:z.literal('removed'),...metadata,removedAt:instant}),
]);
export const socialVoiceReadSchema=z.strictObject({guide:socialVoiceGuideSchema});
/** Historical receipt only. Accepted requires a separate current authorized read. */
export const socialVoiceReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('accepted'),result:socialVoiceSavedSchema}),
 z.strictObject({state:z.literal('refused'),reason:z.string().min(1).max(100)}),
 z.strictObject({state:z.literal('unknown')}),
]);
export type SocialVoicePreference=z.infer<typeof socialVoicePreferenceSchema>;
export type SocialVoiceSaveInput=z.infer<typeof socialVoiceSaveInputSchema>;
export type SocialVoiceSaveCommand=z.infer<typeof socialVoiceSaveCommandSchema>;
export type SocialVoiceGuide=z.infer<typeof socialVoiceGuideSchema>;
export type SocialVoiceReceipt=z.infer<typeof socialVoiceReceiptSchema>;
