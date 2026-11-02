import { z } from 'zod';
import { bookingLinkSettingSchema, commandIdSchema, semanticVersionSchema } from '@fss/contracts';

/** The one workspace setting the browser may read or write. Every other key stays out of reach. */
export const bookingLinkBrowserSchemas: Readonly<Record<string, z.ZodType>> = {
  '/settings/history': z.strictObject({ settingKey: z.literal('booking_link'), limit: z.literal(1).optional() }),
  '/settings/update': z.strictObject({
    settingKey: z.literal('booking_link'), value: bookingLinkSettingSchema, changeNote: z.string().trim().max(500).optional(),
    commandId: commandIdSchema, clientVersion: semanticVersionSchema.optional(),
  }),
};
const refusal = z.strictObject({ status: z.literal('refused'), replayed: z.boolean(), reason: z.enum(['invalid_value', 'admin_only']) });
/** A refused value is content, not auth loss: the browser client treats a bare 409 as a lost session. */
export function bookingLinkBrowserResult(path: string, status: number, body: unknown): { status: number; body: unknown } | null {
  if (path !== '/settings/update' || status !== 409) return null;
  const parsed = refusal.safeParse(body);
  return parsed.success ? { status: 200, body: parsed.data } : null;
}
