import { z } from 'zod';
import { bookingLinkSettingSchema, commandIdSchema, semanticVersionSchema } from '@fss/contracts';

/** The one workspace setting the browser may read or write. Every other key stays out of reach. */
const BOOKING_LINK_KEY = 'booking_link';
export const BOOKING_LINK_BROWSER_PATHS = Object.freeze({
  read: '/settings/booking-link/read',
  update: '/settings/booking-link/update',
} as const);

/** Browser bodies never name a setting key: the key is fixed here, not chosen by the browser. */
export const bookingLinkBrowserSchemas: Readonly<Record<string, z.ZodType>> = {
  [BOOKING_LINK_BROWSER_PATHS.read]: z.strictObject({}),
  [BOOKING_LINK_BROWSER_PATHS.update]: z.strictObject({
    value: bookingLinkSettingSchema, changeNote: z.string().trim().max(500).optional(),
    commandId: commandIdSchema, clientVersion: semanticVersionSchema.optional(),
  }),
};

/** Maps a dedicated browser path onto the existing settings API route, pinned to the booking_link key. */
export function bookingLinkApiRequest(path: string, body: unknown): { path: string; body: unknown } | null {
  if (path === BOOKING_LINK_BROWSER_PATHS.read) return { path: '/settings/history', body: { settingKey: BOOKING_LINK_KEY, limit: 1 } };
  if (path !== BOOKING_LINK_BROWSER_PATHS.update) return null;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  return { path: '/settings/update', body: { ...body, settingKey: BOOKING_LINK_KEY } };
}

const refusal = z.strictObject({ status: z.literal('refused'), replayed: z.boolean(), reason: z.enum(['invalid_value', 'admin_only']) });
/** A refused value is content, not auth loss: the browser client treats a bare 409 as a lost session. */
export function bookingLinkBrowserResult(path: string, status: number, body: unknown): { status: number; body: unknown } | null {
  if (path !== BOOKING_LINK_BROWSER_PATHS.update || status !== 409) return null;
  const parsed = refusal.safeParse(body);
  return parsed.success ? { status: 200, body: parsed.data } : null;
}
