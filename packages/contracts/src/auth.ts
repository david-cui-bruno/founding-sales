import { z } from 'zod';
import { clientVersionRangeSchema, semanticVersionSchema } from './clientVersion.ts';
import { instant, membershipRoleSchema, uuid } from './foundationRows.ts';

/**
 * The wire contract of identity: sign-in, sessions, devices, commands and the
 * audited-read matrix (specification 5.1, 5.2, 5.3, 14.1 and Appendix F).
 *
 * Two rules shape everything here.
 *
 * **Refusals are a closed set.** Section 15 asks for "stable refusal and hold reason
 * codes"; `AUTH_REFUSAL_CODES` is that set for identity, and the API never invents a
 * string outside it. A caller may switch on the code; the message is for a person.
 *
 * **A secret appears in exactly one direction, once.** `sessionGrantSchema` is the
 * only shape that carries an access token, a refresh credential or a device secret,
 * it is only ever a response, and nothing that describes a stored row (`deviceView`,
 * `sessionView`) has a field that could hold one.
 */

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const AUTH_REFUSAL_CODES = [
  // Sign-in
  'client_upgrade_required',
  'workspace_unknown',
  'authorization_request_unknown',
  'authorization_request_expired',
  'provider_error',
  'token_exchange_failed',
  'membership_required',
  'handoff_unknown',
  'handoff_expired',
  'already_claimed',
  // Id-token validation
  'malformed_token',
  'unsupported_algorithm',
  'unknown_signing_key',
  'bad_signature',
  'issuer_mismatch',
  'audience_mismatch',
  'authorized_party_mismatch',
  'token_expired',
  'token_issued_in_future',
  'token_not_yet_valid',
  'nonce_mismatch',
  'email_unverified',
  'hosted_domain_mismatch',
  'subject_missing',
  // Sessions and devices
  'unauthenticated',
  'malformed_credential',
  'session_expired',
  'session_ended',
  'reauthentication_required',
  'membership_inactive',
  'device_revoked',
  'credential_unknown',
  'credential_expired',
  'credential_reuse',
  // Commands
  'command_payload_mismatch',
  'command_device_mismatch',
  'command_kind_mismatch',
  // Administration
  'admin_only',
  'last_active_admin',
  'membership_unknown',
  'device_unknown',
] as const;
export const authRefusalCodeSchema = z.enum(AUTH_REFUSAL_CODES);
export type AuthRefusalCode = z.infer<typeof authRefusalCodeSchema>;

// ---------------------------------------------------------------------------
// Token shapes
//
// Both credentials name their workspace in the first field, so the server's lookup
// begins with `workspace_id` even though the caller is not yet authenticated
// (specification 6; docs/decisions/g2-session-token-shape.md).
// ---------------------------------------------------------------------------

const SECRET = '[A-Za-z0-9_-]{43}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export const ACCESS_TOKEN_PREFIX = 'fssa1';
export const REFRESH_CREDENTIAL_PREFIX = 'fssr1';

export const accessTokenSchema = z
  .string()
  .regex(new RegExp(`^${ACCESS_TOKEN_PREFIX}\\.${UUID}\\.${SECRET}$`), 'an FSS access token');

export const refreshCredentialSchema = z
  .string()
  .regex(
    new RegExp(`^${REFRESH_CREDENTIAL_PREFIX}\\.${UUID}\\.${UUID}\\.[1-9][0-9]{0,15}\\.${SECRET}$`),
    'an FSS device refresh credential',
  );

/** The one-time secret the desktop app generates to collect the grant its browser earned. */
export const handoffSecretSchema = z.string().regex(new RegExp(`^${SECRET}$`), 'a sign-in handoff secret');

export const deviceSecretSchema = z.string().regex(new RegExp(`^${SECRET}$`), 'a device secret');

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export const deviceLabelSchema = z.string().trim().min(1).max(120);

export const signInStartRequestSchema = z.strictObject({
  workspaceId: uuid,
  deviceLabel: deviceLabelSchema,
  clientVersion: semanticVersionSchema,
});
export type SignInStartRequest = z.infer<typeof signInStartRequestSchema>;

export const signInStartResponseSchema = z.strictObject({
  /** Opened in the system browser. Never rendered inside the app (specification 5.1). */
  authorizationUrl: z.url(),
  handoffSecret: handoffSecretSchema,
  expiresAt: instant,
});
export type SignInStartResponse = z.infer<typeof signInStartResponseSchema>;

export const signInClaimRequestSchema = z.strictObject({
  handoffSecret: handoffSecretSchema,
  clientVersion: semanticVersionSchema,
});
export type SignInClaimRequest = z.infer<typeof signInClaimRequestSchema>;

/**
 * Everything the Mac must store, handed over exactly once. The device secret goes to
 * the macOS Keychain; nothing here is ever written to the API's logs or database in
 * plaintext (specification 5.3).
 */
export const sessionGrantSchema = z.strictObject({
  workspaceId: uuid,
  userId: uuid,
  role: membershipRoleSchema,
  deviceId: uuid,
  deviceSecret: deviceSecretSchema,
  accessToken: accessTokenSchema,
  accessTokenExpiresAt: instant,
  refreshCredential: refreshCredentialSchema,
  /** The 30-day boundary. After it, only a full Google sign-in works. */
  reauthenticateAfter: instant,
  supportedClientVersions: clientVersionRangeSchema,
});
export type SessionGrant = z.infer<typeof sessionGrantSchema>;

export const sessionRenewRequestSchema = z.strictObject({
  refreshCredential: refreshCredentialSchema,
  clientVersion: semanticVersionSchema,
});
export type SessionRenewRequest = z.infer<typeof sessionRenewRequestSchema>;

/** A renewal returns no device secret: the Mac already has one and it does not rotate. */
export const sessionRenewalSchema = sessionGrantSchema.omit({ deviceSecret: true });
export type SessionRenewal = z.infer<typeof sessionRenewalSchema>;

// ---------------------------------------------------------------------------
// The client-version notice
//
// Specification 5.3: "An outdated client may read only the upgrade instruction and
// cannot mutate." This is that instruction, and it is readable without a session.
// ---------------------------------------------------------------------------

export const clientVersionNoticeSchema = z.strictObject({
  supported: clientVersionRangeSchema,
  /**
   * Where the current build is published. A public URL, never a signed one; in
   * production the signed update manifest the desktop reads (lane g86), so it is
   * machine-facing and the Mac never shows it: the person reads `instruction`.
   */
  upgradeUrl: z.url(),
  /** A fixed sentence for the banner. The client never composes its own. */
  instruction: z.string().min(1).max(300),
});
export type ClientVersionNotice = z.infer<typeof clientVersionNoticeSchema>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const commandIdSchema = z.string().regex(/^[0-9a-zA-Z_:-]{1,128}$/, 'a command id');
export const commandKindSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'a command kind');

export const commandEnvelopeSchema = z.strictObject({
  commandId: commandIdSchema,
  kind: commandKindSchema,
  clientVersion: semanticVersionSchema,
  payload: z.unknown(),
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

export const commandResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('accepted'),
    /** True when this answer came from the receipt rather than from fresh work. */
    replayed: z.boolean(),
    result: z.unknown(),
  }),
  z.strictObject({
    status: z.literal('refused'),
    replayed: z.boolean(),
    reason: z.string().min(1).max(80),
  }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

// ---------------------------------------------------------------------------
// Redacted administration views (Appendix F)
// ---------------------------------------------------------------------------

export const membershipViewSchema = z.strictObject({
  userId: uuid,
  email: z.string().max(320),
  displayName: z.string().max(200),
  role: membershipRoleSchema,
  status: z.enum(['active', 'inactive']),
  createdAt: instant,
  deactivatedAt: instant.nullable(),
});
export type MembershipView = z.infer<typeof membershipViewSchema>;

/** No `secretHash`: a hash of a live credential is still a thing worth not handing out. */
export const deviceViewSchema = z.strictObject({
  deviceId: uuid,
  userId: uuid,
  deviceLabel: deviceLabelSchema,
  clientVersion: semanticVersionSchema.nullable(),
  status: z.enum(['active', 'revoked']),
  credentialGeneration: z.number().int().min(1),
  registeredAt: instant,
  lastSeenAt: instant.nullable(),
  revokedAt: instant.nullable(),
});
export type DeviceView = z.infer<typeof deviceViewSchema>;

// ---------------------------------------------------------------------------
// The audited-read matrix (specification 5.2, Appendix F)
//
// "Admin reads of message bodies, drafts, mailbox diagnostics, and exports create
// access audit events." None of those rows exist yet; the hook and its vocabulary do,
// so the slice that adds bodies inherits the rule rather than inventing it.
// ---------------------------------------------------------------------------

export const SENSITIVE_READ_KINDS = [
  'message_body',
  'draft',
  'mailbox_diagnostics',
  'export',
  'note',
  'callback',
] as const;
export const sensitiveReadKindSchema = z.enum(SENSITIVE_READ_KINDS);
export type SensitiveReadKind = z.infer<typeof sensitiveReadKindSchema>;

/** Which column of Appendix F a read falls in. */
export const READ_VISIBILITY_CLASSES = ['any_active_member', 'assigned_or_admin', 'mailbox_owner_or_admin'] as const;
export const readVisibilityClassSchema = z.enum(READ_VISIBILITY_CLASSES);
export type ReadVisibilityClass = z.infer<typeof readVisibilityClassSchema>;

export const VISIBILITY_OF_READ: Readonly<Record<SensitiveReadKind, ReadVisibilityClass>> = Object.freeze({
  message_body: 'assigned_or_admin',
  draft: 'assigned_or_admin',
  note: 'assigned_or_admin',
  callback: 'assigned_or_admin',
  mailbox_diagnostics: 'mailbox_owner_or_admin',
  export: 'assigned_or_admin',
});
