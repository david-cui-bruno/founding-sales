import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {callingProviderSettingSchema,telephonyBudgetSettingSchema} from './settings.ts';

const version=z.number().int().nonnegative();
export const callingSetupSchema=z.strictObject({
 callingProvider:callingProviderSettingSchema.extend({version}),
 telephonyBudget:telephonyBudgetSettingSchema.extend({version}),
 spentTodayCents:z.number().int().nonnegative(),configured:z.boolean(),
});
export const callingSetupInputSchema=z.strictObject({expectedVersion:version,provider:z.enum(['tel','twilio'])});
export const callingSetupCommandSchema=callingSetupInputSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const callingSetupSavedSchema=z.strictObject({provider:z.enum(['tel','twilio']),version:version});
export const CALLING_SETUP_REFUSALS=['admin_only','setting_version_conflict','integration_unconfigured','telephony_budget_disabled'] as const;
export const callingSetupAnswerSchema=z.discriminatedUnion('status',[
 z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:callingSetupSavedSchema}),
 z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(CALLING_SETUP_REFUSALS)}),
]);
export const callingSetupReceiptInputSchema=z.strictObject({commandId:commandIdSchema,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u)});
export const callingSetupReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('unknown')}),
 z.strictObject({state:z.literal('refused'),reason:z.enum(CALLING_SETUP_REFUSALS)}),
 z.strictObject({state:z.literal('accepted'),result:callingSetupSavedSchema}),
]);
export type CallingSetup=z.infer<typeof callingSetupSchema>;
export type CallingSetupInput=z.infer<typeof callingSetupInputSchema>;
export type CallingSetupSaved=z.infer<typeof callingSetupSavedSchema>;
export type CallingSetupReceipt=z.infer<typeof callingSetupReceiptSchema>;

/** Editing the daily ceiling preserves the current rate and per-call duration. */
export const callingBudgetInputSchema=z.strictObject({expectedVersion:version,dailyCeilingCents:telephonyBudgetSettingSchema.shape.dailyCeilingCents});
export const callingBudgetCommandSchema=callingBudgetInputSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const callingBudgetSavedSchema=z.strictObject({dailyCeilingCents:telephonyBudgetSettingSchema.shape.dailyCeilingCents,version});
export const callingBudgetAnswerSchema=z.discriminatedUnion('status',[
 z.strictObject({status:z.literal('accepted'),replayed:z.boolean(),result:callingBudgetSavedSchema}),
 z.strictObject({status:z.literal('refused'),replayed:z.boolean(),reason:z.enum(CALLING_SETUP_REFUSALS)}),
]);
export const callingBudgetReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('unknown')}),
 z.strictObject({state:z.literal('refused'),reason:z.enum(CALLING_SETUP_REFUSALS)}),
 z.strictObject({state:z.literal('accepted'),result:callingBudgetSavedSchema}),
]);
export type CallingBudgetInput=z.infer<typeof callingBudgetInputSchema>;
export type CallingBudgetSaved=z.infer<typeof callingBudgetSavedSchema>;
export type CallingBudgetReceipt=z.infer<typeof callingBudgetReceiptSchema>;
