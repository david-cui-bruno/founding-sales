import { z } from 'zod';
import {
  accessTokenSchema,
  clientVersionRangeSchema,
  deviceSecretSchema,
  handoffSecretSchema,
  instant,
  membershipRoleSchema,
  refreshCredentialSchema,
  uuid,
} from '@fss/contracts';

/**
 * What the main process keeps, what the renderer is allowed to see, and the one
 * bridge between them (specification 14.2).
 *
 * "Electron owns presentation, an encrypted 24-hour read-only cache without
 * bodies/drafts/attachments, session/device handling, signed update enforcement...
 * It contains no authoritative sequence, suppression, policy, eligibility, or send
 * logic."
 *
 * The split is enforced by the types. `StoredDevice` and `StoredSession` never leave
 * the main process; `DesktopState` is what the renderer receives, and it has no field
 * that could carry a token, a device secret or a message body — so a careless `send`
 * cannot leak one, because there is nowhere to put it.
 */

// ---------------------------------------------------------------------------
// Main-process state. Never crosses the bridge.
// ---------------------------------------------------------------------------

/** The public part of the device registration. The secret lives in the Keychain. */
export const storedDeviceSchema = z.strictObject({
  workspaceId: uuid,
  userId: uuid,
  deviceId: uuid,
  role: membershipRoleSchema,
  deviceLabel: z.string().min(1).max(120),
  apiBaseUrl: z.url(),
  registeredAt: instant,
});
export type StoredDevice = z.infer<typeof storedDeviceSchema>;

/** Held in memory only. A restart signs in again with the refresh credential. */
export const storedSessionSchema = z.strictObject({
  accessToken: accessTokenSchema,
  accessTokenExpiresAt: instant,
  refreshCredential: refreshCredentialSchema,
  reauthenticateAfter: instant,
});
export type StoredSession = z.infer<typeof storedSessionSchema>;

export const signInHandoffSchema = z.strictObject({
  authorizationUrl: z.url(),
  handoffSecret: handoffSecretSchema,
  expiresAt: instant,
});
export type SignInHandoff = z.infer<typeof signInHandoffSchema>;

export { deviceSecretSchema };

// ---------------------------------------------------------------------------
// The encrypted offline cache (specification 5.3, 14.2)
// ---------------------------------------------------------------------------

/**
 * The only shape the cache may hold. `strictObject` all the way down is the
 * enforcement of "no message bodies, drafts, attachments, or mailbox diagnostics":
 * a field that could carry one does not exist, so writing one is a parse failure.
 */
export const cachedTodayCardSchema = z.strictObject({
  firmId: uuid,
  firmName: z.string().min(1).max(200),
  lane: z.enum(['reply', 'callback', 'due_work', 'new_firm']),
  dueAt: instant,
  counts: z.strictObject({
    replies: z.number().int().min(0),
    emailsDue: z.number().int().min(0),
    callsDue: z.number().int().min(0),
    linkedInDue: z.number().int().min(0),
  }),
});
export type CachedTodayCard = z.infer<typeof cachedTodayCardSchema>;

export const cachedTodaySchema = z.strictObject({
  workspaceId: uuid,
  snapshotDate: z.iso.date(),
  businessTimeZone: z.string().min(1).max(64),
  cards: z.array(cachedTodayCardSchema),
});
export type CachedToday = z.infer<typeof cachedTodaySchema>;

/** 24 hours, from specification 5.3. Not configurable: it is the contract. */
export const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The bridge. Everything the renderer may ask for or be told.
// ---------------------------------------------------------------------------

export const SCREENS = ['sign_in', 'signing_in', 'today', 'upgrade_required'] as const;
export type Screen = (typeof SCREENS)[number];

export const desktopStateSchema = z.strictObject({
  screen: z.enum(SCREENS),
  clientVersion: z.string(),
  supportedClientVersions: clientVersionRangeSchema.nullable(),
  /** Null until this Mac is registered. Identifiers and a label; never a secret. */
  device: z
    .strictObject({
      deviceId: uuid,
      deviceLabel: z.string(),
      workspaceId: uuid,
      role: membershipRoleSchema,
      registeredAt: instant,
    })
    .nullable(),
  /** Whether the cloud answered the last time we asked. */
  online: z.boolean(),
  /** True when the list on screen came from the cache rather than from the API. */
  stale: z.boolean(),
  /** When the shown list was fetched, or null when there is nothing to show. */
  asOf: instant.nullable(),
  /** Whether a mutating command may be attempted at all. */
  mayMutate: z.boolean(),
  /** A stable code, never a sentence composed here. */
  notice: z.string().nullable(),
  today: cachedTodaySchema.nullable(),
});
export type DesktopState = z.infer<typeof desktopStateSchema>;

export interface DesktopBridge {
  state(): Promise<DesktopState>;
  /** Opens the system browser and waits for the grant. */
  signIn(input: { readonly workspaceId: string; readonly deviceLabel: string }): Promise<DesktopState>;
  signOut(): Promise<DesktopState>;
  refreshToday(): Promise<DesktopState>;
}

declare global {
  var callie: DesktopBridge | undefined;
}
