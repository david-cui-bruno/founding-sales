import { z } from 'zod';
import {
  CRM_EXTRACTION_ENDPOINT, CRM_EXTRACTION_MODELS,
  crmExtractionPurposeSaveSchema, crmExtractionPurposeSchema,
  CRM_OWNER_SCOPE_VERSION, businessPolicySchema, crmCapabilityReadResponseSchema,
} from '@fss/contracts';
import { operations } from '../app/bridges.ts';

export type ExtractionPurpose = z.infer<typeof crmExtractionPurposeSchema>;
export const extractionSetupInput = crmExtractionPurposeSaveSchema
  .omit({ commandId: true, clientVersion: true })
  .extend({ enabled: z.literal(false), endpointId: z.literal(CRM_EXTRACTION_ENDPOINT), modelVersion: z.enum(CRM_EXTRACTION_MODELS), allowedSourceKinds:z.tuple([z.literal('mail')]),mailCaptureOwnerApprovalId:z.uuid() });
export type ExtractionSetupInput = z.infer<typeof extractionSetupInput>;
export interface ExtractionSetupPorts {
  read(): Promise<ExtractionPurpose>;
  readCaptureBinding?():Promise<{mailboxId:string;mailboxEmail:string;ownerApprovalId:string}|null>;
  save(input: ExtractionSetupInput): Promise<{ revision: number; enabled: false }>;
}
export const extractionSetupPorts: ExtractionSetupPorts = {
  read: async () => {
    const api = operations();
    if (!api) throw new Error('unavailable');
    return crmExtractionPurposeSchema.parse(await api.read('crm.processingPurpose', {scopeVersion:CRM_OWNER_SCOPE_VERSION}));
  },
  readCaptureBinding:async()=>{
    const api=operations();if(!api)throw new Error('unavailable');
    const policy=businessPolicySchema.parse(await api.read('crm.businessPolicyRead',{}));
    if(!policy.mailboxId||!policy.emailAddress)return null;
    const capture=crmCapabilityReadResponseSchema.parse(await api.read('crm.capabilityRead',{capability:'mail_capture',mailboxId:policy.mailboxId,scopeVersion:CRM_OWNER_SCOPE_VERSION}));
    return capture.scopeVersion===CRM_OWNER_SCOPE_VERSION&&capture.enabled&&capture.ready&&capture.ownerApprovalId&&capture.configuration?.capability==='mail_capture'&&capture.configuration.forwardScope?
      {mailboxId:policy.mailboxId,mailboxEmail:policy.emailAddress,ownerApprovalId:capture.ownerApprovalId}:null;
  },
  save: async input => {
    const api = operations();
    if (!api) throw new Error('unavailable');
    return z.strictObject({ revision: z.number().int().positive(), enabled: z.literal(false) })
      .parse(await api.command('crm.processingPurposeSave', extractionSetupInput.parse(input)));
  },
};

export const extractionSetupFields = [
  ['accessGrantVersion', 'Access grant version'],
  ['dataHandlingVersion', 'Data handling version'],
  ['dailyCeilingCents', 'Daily hard ceiling (USD cents)'],
  ['monthlyCeilingCents', 'Monthly hard ceiling (USD cents)'],
  ['inputTokenPriceMicros', 'Input price (microdollars per token)'],
  ['outputTokenPriceMicros', 'Output price (microdollars per token)'],
] as const;
export type ExtractionDraft = Record<(typeof extractionSetupFields)[number][0] | 'endpointId' | 'modelVersion', string>;
export function extractionDraft(purpose: ExtractionPurpose): ExtractionDraft {
  return Object.fromEntries([
    ...extractionSetupFields.map(([key]) => [key, purpose.configured ? String(purpose[key]) : '']),
    ['endpointId', purpose.configured ? purpose.endpointId : ''],
    ['modelVersion', purpose.configured ? purpose.modelVersion : ''],
  ]) as ExtractionDraft;
}
export function extractionSaveInput(draft: ExtractionDraft, expectedRevision: number, captureOwnerApprovalId?:string) {
  return extractionSetupInput.safeParse({
    ...draft, expectedRevision, enabled: false,
    dailyCeilingCents: /^\d+$/u.test(draft.dailyCeilingCents) ? Number(draft.dailyCeilingCents) : NaN,
    monthlyCeilingCents: /^\d+$/u.test(draft.monthlyCeilingCents) ? Number(draft.monthlyCeilingCents) : NaN,
    allowedSourceKinds:['mail'],mailCaptureOwnerApprovalId:captureOwnerApprovalId,
  });
}

/** Do not render arbitrary server errors, which can contain private details. */
export function extractionSetupNotice(error: unknown): string {
  const reason = error instanceof Error ? error.message : '';
  if (reason === 'purpose_revision_conflict') return 'Settings changed. Reload current configuration and review it before saving again.';
  if (reason === 'purpose_access_denied' || reason === 'unauthenticated') return 'Only the current authenticated owner administrator can save this configuration.';
  return 'Configuration could not be confirmed. Reload before trying again. No activation was requested.';
}
