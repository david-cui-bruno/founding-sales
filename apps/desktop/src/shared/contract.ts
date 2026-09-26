import { z } from 'zod';
import {
  MAILBOX_STATUSES,
  MAILBOX_SYNC_STATES,
  TODAY_LANES,
  accessTokenSchema,
  clientVersionRangeSchema,
  deviceSecretSchema,
  instant,
  membershipRoleSchema,
  refreshCredentialSchema,
  signInStartResponseSchema,
  uuid,
  type SignInStartResponse,
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

/**
 * `POST /auth/sign-in/start`'s answer: `@fss/contracts`' `signInStartResponseSchema`,
 * named for the Mac (lane g78). It was a second copy of the same three fields.
 */
export const signInHandoffSchema = signInStartResponseSchema;
export type SignInHandoff = SignInStartResponse;

export { deviceSecretSchema };

/**
 * The workspace and the name of the last sign-in on this Mac (wave 1). Public
 * identifiers, kept in their own file beside `device.json` so that signing out — which
 * deletes `device.json` — does not make the next sign-in ask for a UUID again.
 */
export const rememberedWorkspaceSchema = z.strictObject({
  workspaceId: uuid,
  deviceLabel: z.string().trim().min(1).max(120),
});
export type RememberedWorkspace = z.infer<typeof rememberedWorkspaceSchema>;

// ---------------------------------------------------------------------------
// The encrypted offline cache (specification 5.3, 14.2)
// ---------------------------------------------------------------------------

/**
 * The only shape the cache may hold. `strictObject` all the way down is the
 * enforcement of "no message bodies, drafts, attachments, or mailbox diagnostics":
 * a field that could carry one does not exist, so writing one is a parse failure.
 *
 * This is the Mac's retention rule, not the wire. `/today` is read with
 * `@fss/contracts`' `todayListResponseSchema` first (lane g78), which drops any key the
 * contract does not declare, and the result is then held to this. So an API that adds
 * a field to the list is still readable here, and nothing it adds can reach the disk.
 * The lanes and the 300-character firm name are the contract's.
 */
export const cachedTodayCardSchema = z.strictObject({
  firmId: uuid,
  firmName: z.string().min(1).max(300),
  lane: z.enum(TODAY_LANES),
  dueAt: instant,
  counts: z.strictObject({
    replies: z.number().int().min(0),
    emailsDue: z.number().int().min(0),
    callsDue: z.number().int().min(0),
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
  /**
   * Whether a mutating command may be attempted at all: signed in, and a version the API
   * accepts. Not whether the last call reached the server — offline is a banner, and a
   * command sent offline fails with its own notice (wave 1).
   */
  mayMutate: z.boolean(),
  /** A stable code, never a sentence composed here. */
  notice: z.string().nullable(),
  today: cachedTodaySchema.nullable(),
  /** The last sign-in's workspace and name, so sign-in need not ask for them; null on a new Mac. */
  rememberedWorkspace: rememberedWorkspaceSchema.nullable(),
});
export type DesktopState = z.infer<typeof desktopStateSchema>;

/**
 * The views the Window menu's ⌘1–⌘6 and a deep link may ask the one window for (wave 1),
 * as a closed set, in the sidebar's order. A firm's own route is the page's alone.
 */
export const ROUTE_NAMES = ['today', 'replies', 'firms', 'sequences', 'admin', 'dashboard'] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

/**
 * One of the six names, or null. Compared with each literal rather than looked up as a
 * key, so `constructor` and `__proto__` are refused like any other string.
 */
export function routeNameOf(value: unknown): RouteName | null {
  return ROUTE_NAMES.find(name => name === value) ?? null;
}

export interface DesktopBridge {
  state(): Promise<DesktopState>;
  /**
   * Opens the system browser and waits for the grant. Either field left out is the
   * remembered one (wave 1): a Mac that has signed in before sends neither.
   */
  signIn(input: { readonly workspaceId?: string | undefined; readonly deviceLabel?: string | undefined }): Promise<DesktopState>;
  signOut(): Promise<DesktopState>;
  refreshToday(): Promise<DesktopState>;
  /**
   * The Window menu and deep links (wave 1): called with one of the six route names
   * whenever the main process asks the window to show that view. The preload checks
   * the name against `ROUTE_NAMES` before it gets here.
   */
  onNavigate(listener: (route: RouteName) => void): void;
}

// ---------------------------------------------------------------------------
// The Mailbox row on "This Mac" (specification 5.1, 12.1, 12.6)
// ---------------------------------------------------------------------------

/**
 * What the Mailbox row may be told, and nothing more.
 *
 * Desktop 1.0.0 shipped with no way to connect Gmail at all: the API served
 * `POST /gmail/connect` and `GET /gmail/status` and nothing on the Mac called them
 * (docs/greenfield/release.md 8.0x). This is the row's whole contract. The address,
 * the connection status and the baseline state are what the owner needs to see that
 * the grant worked; the mailbox id, the sync error text and the coverage watermark stay
 * in the main process, and no field here could carry a token or a consent URL — the
 * URL goes from the API to `shell.openExternal` without crossing the bridge.
 */
export const mailboxStateSchema = z.strictObject({
  /** What `/gmail/status` last said, or null until a read has answered. */
  status: z
    .strictObject({
      connected: z.boolean(),
      mailbox: z
        .strictObject({
          emailAddress: z.string().min(3).max(320),
          status: z.enum(MAILBOX_STATUSES),
          syncState: z.enum(MAILBOX_SYNC_STATES),
        })
        .nullable(),
    })
    .nullable(),
  /** True while the consent screen is open and the main process is waiting for the grant. */
  connecting: z.boolean(),
  /** Whether a connection may be started now: signed in, online, a supported version, not already waiting. */
  mayConnect: z.boolean(),
  /** A stable code — the API's refusal reason or one of the bridge's own — never a sentence. */
  notice: z.string().min(1).max(80).nullable(),
});
export type MailboxState = z.infer<typeof mailboxStateSchema>;

/**
 * Three methods and no fourth. There is deliberately no `disconnect`: the workspace's
 * thirty-day rule (docs/greenfield/mail.md, "Mailbox lifecycle") keeps a mailbox that
 * sent automated mail connected for thirty days, and its guard — a refusal with an
 * audited admin override — is not built, so a Disconnect button here would be a way
 * round a rule the software does not yet enforce.
 */
export interface MailboxBridge {
  /** Reads `/gmail/status`. */
  state(): Promise<MailboxState>;
  /** Reads `/gmail/status` again and stops waiting for a grant, if it was. */
  refresh(): Promise<MailboxState>;
  /** Starts the grant, opens Google's consent screen in the system browser, and waits for it. */
  connect(): Promise<MailboxState>;
}

declare global {
  var callie: DesktopBridge | undefined;
  var callieMailbox: MailboxBridge | undefined;
}
