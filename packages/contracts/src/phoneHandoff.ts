import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { e164, instant, uuid } from './foundationRows.ts';

/** Authorize one phone-app handoff, never a reusable dial link. */
export const reservePhoneHandoffCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  firmId: uuid,
  routeId: uuid,
  routeVersion: z.number().int().min(1),
  opportunityId: uuid.nullable().optional(),
  itemId: uuid.optional(),
});
export type ReservePhoneHandoffCommand = z.infer<typeof reservePhoneHandoffCommandSchema>;

/** The receipt stores identity only. A replay never carries a number or URI. */
export const phoneHandoffIdentitySchema = z.strictObject({
  attemptId: uuid,
  firmId: uuid,
  routeId: uuid,
  reservedAt: instant,
  expiresAt: instant,
});
export type PhoneHandoffIdentity = z.infer<typeof phoneHandoffIdentitySchema>;

export const PHONE_HANDOFF_MAX_LIFETIME_MS = 15_000;
const identity = phoneHandoffIdentitySchema.shape;
const fresh = z.strictObject({
  ...identity,
  actionable: z.literal(true),
  e164,
  telUri: z.string().regex(/^tel:\+[1-9][0-9]{7,14}$/u),
  /** Starts at the desktop's request-start monotonic instant, not response arrival. */
  validForMilliseconds: z.number().int().min(1).max(PHONE_HANDOFF_MAX_LIFETIME_MS),
}).refine(value => value.telUri === `tel:${value.e164}`, 'The URI must match the authorized endpoint')
  .refine(value => {
    const lifetime = Date.parse(value.expiresAt) - Date.parse(value.reservedAt);
    return lifetime > 0 && lifetime <= PHONE_HANDOFF_MAX_LIFETIME_MS && value.validForMilliseconds <= lifetime;
  }, 'The dispatch allowance must fit the server reservation lifetime');
const reconciliation = z.strictObject({
  ...identity,
  routeId: uuid.nullable(),
  actionable: z.literal(false),
  e164: z.null(),
  telUri: z.null(),
  validForMilliseconds: z.literal(0),
  reason: z.literal('handoff_reconciliation_required'),
});
/** Only an unreplayed, committed reservation can produce the fresh branch. */
export const phoneHandoffResultSchema = z.union([fresh, reconciliation]);
export type PhoneHandoffResult = z.infer<typeof phoneHandoffResultSchema>;

export const PHONE_HANDOFF_REFUSAL_CODES = [
  'phone_handoff_unavailable',
  'handoff_reconciliation_required',
  'dnc_coverage_unknown',
  'dnc_registry_match',
] as const;
export type PhoneHandoffRefusalCode = (typeof PHONE_HANDOFF_REFUSAL_CODES)[number];
