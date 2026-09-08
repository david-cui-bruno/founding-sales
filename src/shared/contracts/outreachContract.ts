import { z } from 'zod';

const id = z.string().min(1).max(256);
const line = z.string().max(240).regex(/^[^\r\n]*$/).refine(value => !value.includes('\0'));
const body = z.string().max(20000).refine(value => !value.includes('\0'));
export const setupStateSchema = z.enum(['unconfigured','ready','locked','reauthorize','error']);
export const outreachStatusSchema = z.object({
  model: setupStateSchema, modelName: z.string().max(200), gmail: setupStateSchema,
  accountEmail: z.string().email().nullable(), senderName: line, postalAddress: z.string().max(1000),
}).strict();
export const configureOutreachSchema = z.object({
  apiKey: z.string().min(1).max(4096).optional(), model: z.string().min(1).max(200).optional(),
  googleClientId: z.string().min(1).max(1024).optional(), googleClientSecret: z.string().max(4096).optional(),
  senderName: line.optional(), postalAddress: z.string().max(1000).optional(),
}).strict();
export const emailDraftSchema = z.object({
  id, personId:id, salesCycleId:id, contactMethodId:id, recipient:z.string().email(),
  senderEmail:z.string().email().nullable().optional(), footer:z.string().max(1500).optional(),
  subject:line, body, revision:z.number().int().positive(),
  status:z.enum(['draft','sending','sent','unknown']), generation:z.enum(['none','model','edited']),
  messageId:z.string().max(256).nullable(), notice:z.string().max(1000).nullable(),
  updatedAt:z.string().datetime({offset:true}),
}).strict();
export const openDraftSchema = z.object({personId:id,contactMethodId:id}).strict();
export const draftRevisionSchema = z.object({draftId:id,expectedRevision:z.number().int().positive()}).strict();
export const saveDraftSchema = draftRevisionSchema.extend({subject:line,body}).strict();
export const sendDraftSchema = draftRevisionSchema.extend({commandId:z.string().uuid()}).strict();
export type SetupState = z.infer<typeof setupStateSchema>;
export type OutreachStatus = z.infer<typeof outreachStatusSchema>;
export type ConfigureOutreach = z.infer<typeof configureOutreachSchema>;
export type EmailDraft = z.infer<typeof emailDraftSchema>;
export type OpenDraftRequest = z.infer<typeof openDraftSchema>;
export type DraftRevisionRequest = z.infer<typeof draftRevisionSchema>;
export type SaveDraftRequest = z.infer<typeof saveDraftSchema>;
export type SendDraftRequest = z.infer<typeof sendDraftSchema>;
export interface OutreachApi {
  status():Promise<OutreachStatus>;
  configure(input:ConfigureOutreach):Promise<OutreachStatus>;
  connectGmail():Promise<OutreachStatus>;
  disconnectGmail():Promise<OutreachStatus>;
  openDraft(input:OpenDraftRequest):Promise<EmailDraft>;
  saveDraft(input:SaveDraftRequest):Promise<EmailDraft>;
  generateDraft(input:DraftRevisionRequest):Promise<EmailDraft>;
  sendDraft(input:SendDraftRequest):Promise<EmailDraft>;
}
