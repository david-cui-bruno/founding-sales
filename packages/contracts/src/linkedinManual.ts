import { z } from 'zod';
import { uuid, instant } from './foundationRows.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';

// A ledger records human assertions, never native observation or permission to act.
export const linkedinManualKindSchema = z.enum(['connection', 'invite', 'message', 'reply', 'refusal']);
export const linkedinManualStateSchema = z.enum(['unknown', 'pending', 'accepted']);
export const linkedinManualReadSchema = z.strictObject({ ledgerId: uuid.optional(), before: z.string().regex(/^[1-9][0-9]{0,18}$/u).refine(value => /^[1-9][0-9]{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n, 'Cursor outside history range.').optional() });
export const linkedinManualBindSchema = z.strictObject({
  ledgerId: uuid, accountId: uuid, personId: uuid, firmId: uuid, claimId: uuid,
  claimRevision: z.number().int().positive(), relationshipId: uuid, relationshipRevision: z.number().int().positive(),
});
export const linkedinManualRecordSchema = z.strictObject({
  ledgerId: uuid, entryId: uuid, expectedRevision: z.number().int().nonnegative(),
  kind: linkedinManualKindSchema, connectionState: linkedinManualStateSchema.nullable(), occurredAt: instant,
  voided: z.boolean(), correction: z.enum(['date', 'kind', 'connection_state', 'void']).nullable(),
}).superRefine((value, ctx) => {
  if ((value.kind === 'connection') !== (value.connectionState !== null)) ctx.addIssue({ code: 'custom', message: 'Only connection records carry a state.' });
  if ((value.expectedRevision === 0) !== (value.correction === null) || (value.expectedRevision === 0 && value.voided)) ctx.addIssue({ code: 'custom', message: 'Corrections require a previous revision.' });
});
const envelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };
export const linkedinManualBindCommandSchema = linkedinManualBindSchema.extend(envelope);
export const linkedinManualRecordCommandSchema = linkedinManualRecordSchema.safeExtend(envelope);
const choiceSchema = linkedinManualBindSchema.omit({ ledgerId: true, accountId: true }).extend({ personName: z.string(), firmName: z.string(), profile: z.string() });
export const linkedinManualEntrySchema = linkedinManualRecordSchema.safeExtend({
  revision: z.number().int().positive(), sequence: z.string(), recordedAt: instant,
  ownerAssertion: z.literal(true), channel: z.literal('linkedin'),
});
export const linkedinManualLedgerSchema = z.strictObject({
  id: uuid, accountId: uuid, personId: uuid, firmId: uuid,
  personName: z.string().nullable(), firmName: z.string().nullable(), profile: z.string().nullable(),
  bindingCurrent: z.boolean(), connectionState: linkedinManualStateSchema,
  handoffRequired: z.boolean(), sendingPermission: z.literal(false), nativeObservation: z.literal(false),
});
export const linkedinManualViewSchema = z.strictObject({
  accounts: z.array(z.strictObject({ id: uuid, displayName: z.string() })),
  choices: z.array(choiceSchema), ledgers: z.array(linkedinManualLedgerSchema),
  history: z.array(linkedinManualEntrySchema), nextBefore: z.string().nullable(),
  coverage: z.literal('manual_owner_assertions_only'),
});
export const linkedinManualSavedSchema = z.strictObject({ ledgerId: uuid, entryId: uuid.nullable(), revision: z.number().int().nonnegative() });
export type LinkedinManualBind = z.infer<typeof linkedinManualBindSchema>;
export type LinkedinManualRecord = z.infer<typeof linkedinManualRecordSchema>;
export type LinkedinManualView = z.infer<typeof linkedinManualViewSchema>;
export type LinkedinManualEntry = z.infer<typeof linkedinManualEntrySchema>;
