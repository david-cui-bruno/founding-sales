import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';

export const bookingInterpretationSourceSchema = z.strictObject({
  sourceId: z.uuid(), sourceRevision: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const bookingInterpretationRequestSchema = z.strictObject({
  commandId: commandIdSchema, clientVersion: semanticVersionSchema,
  source: bookingInterpretationSourceSchema,
  priorSources: z.array(bookingInterpretationSourceSchema).max(3),
});
export const bookingInterpretationReadSchema = z.strictObject({ requestId: z.uuid() });
export type BookingInterpretationSource = z.infer<typeof bookingInterpretationSourceSchema>;
export type BookingInterpretationRequest = z.infer<typeof bookingInterpretationRequestSchema>;
