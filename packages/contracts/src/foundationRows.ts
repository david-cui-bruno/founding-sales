import { z } from 'zod';
import {
  blockedActionKindSchema,
  holdRecoveryActionSchema,
  holdReasonCodeSchema,
  holdScopeKindSchema,
} from './reasonCodes.ts';

/**
 * Zod schemas for the foundation rows created by migration 0001.
 *
 * These describe the rows as the API hands them out and as the worker reads them
 * back: UTC instants as ISO strings, never a naked local time, and a named zone
 * wherever a calendar concept appears (specification 14.1).
 *
 * The database is still the enforcer. These schemas exist so a row that crossed a
 * process boundary is checked before it is trusted, not so a check can be skipped
 * in SQL.
 */

export const uuid = z.uuid();
export const instant = z.iso.datetime({ offset: true });
export const businessDate = z.iso.date();
/** A sha256 digest as the database stores it: 64 lowercase hex characters. */
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 digest in lowercase hex');
/** E.164, the only spelling a calling identity or phone route is stored in. */
export const e164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'an E.164 number');

/**
 * An IANA zone name. Shape only here; `@fss/domain`'s `isKnownTimeZone` asks Intl
 * whether the runtime actually knows it, because a regex cannot.
 */
export const ianaTimeZone = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/, 'an IANA time-zone name');

export const workspaceSchema = z.strictObject({
  id: uuid,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  displayName: z.string().trim().min(1).max(200),
  businessTimeZone: ianaTimeZone,
  createdAt: instant,
  updatedAt: instant,
});

/**
 * The `google_sub` a bootstrapped admin's `users` row carries until that person has
 * signed in for the first time (lane g39).
 *
 * `fss admin workspace bootstrap` has to create the first `users` row before anybody
 * has ever presented an id token, and `google_sub` is `NOT NULL UNIQUE` because it is
 * the durable identity. The real `sub` is not knowable then: Google mints it, it is a
 * decimal string of digits, and nothing outside a signed token may assert one. So the
 * row is written with this sentinel and the e-mail after it, and the first successful
 * sign-in with that e-mail replaces it with the real `sub`
 * (`apps/api/src/auth/signIn.ts`).
 *
 * The prefix is a single constant in one module because two copies of it are two
 * facts that can disagree: a tool that wrote `pending:` and an API that adopted
 * `pending-email:` would leave a workspace whose admin can never sign in, and nothing
 * would say so. It contains a character no Google `sub` has — a `sub` is digits — so
 * a sentinel can never collide with a real identity, and a sentinel row can never be
 * produced by the sign-in path, only by an operator holding the runtime credential.
 */
export const PROVISIONAL_GOOGLE_SUB_PREFIX = 'pending-email:';

/** The sentinel `google_sub` for one e-mail address. Lowercased, as the row is. */
export function provisionalGoogleSub(email: string): string {
  return `${PROVISIONAL_GOOGLE_SUB_PREFIX}${email.toLowerCase()}`;
}

export const membershipRoleSchema = z.enum(['admin', 'salesperson']);

export const deviceSchema = z.strictObject({
  id: uuid,
  workspaceId: uuid,
  userId: uuid,
  deviceLabel: z.string().trim().min(1).max(120),
  /** The server hash only. The plaintext lives in the macOS Keychain and nowhere else. */
  secretHash: sha256Hex,
  credentialGeneration: z.number().int().min(1),
  clientVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),
  status: z.enum(['active', 'revoked']),
  registeredAt: instant,
  lastSeenAt: instant.nullable(),
  revokedAt: instant.nullable(),
});

export const callingIdentitySchema = z
  .strictObject({
    id: uuid,
    workspaceId: uuid,
    /** Null is the reserved future shared line, and it can never be enabled. */
    ownerUserId: uuid.nullable(),
    e164,
    verificationStatus: z.enum(['unverified', 'verified']),
    enabled: z.boolean(),
    createdAt: instant,
    updatedAt: instant,
  })
  .refine(row => row.ownerUserId !== null || !row.enabled, 'a shared calling identity stays disabled')
  .refine(row => !row.enabled || row.verificationStatus === 'verified', 'an enabled identity is verified');

export const commandReceiptSchema = z.strictObject({
  workspaceId: uuid,
  deviceId: uuid,
  commandId: z.string().regex(/^[0-9a-zA-Z_:-]{1,128}$/),
  commandKind: z.string().trim().min(1).max(80),
  payloadHash: sha256Hex,
  resultStatus: z.enum(['accepted', 'refused']),
  result: z.unknown().nullable(),
  createdAt: instant,
});

export const suppressionEventSchema = z.strictObject({
  workspaceId: uuid,
  eventId: z.string().min(1).max(200),
  scope: z.enum(['firm', 'handle']),
  /** Lowercase by construction: the canonicalizer is the only thing that makes one. */
  canonicalKey: z.string().min(1).max(320),
  canonicalizerVersion: z.string().regex(/^[a-z0-9._-]{1,40}$/),
  source: z.enum([
    'prospect_opt_out',
    'prospect_do_not_call',
    'salesperson_manual',
    'import',
    'deletion_tombstone',
    'mistaken_entry_correction',
    'admin_supersession',
  ]),
  actorUserId: uuid.nullable(),
  commandId: z.string().max(128).nullable(),
  recordedAt: instant,
  supersedesEventId: z.string().max(200).nullable(),
  supersessionReason: z.enum(['mistaken_entry', 'correction', 'documented_reconsent']).nullable(),
});

export const activeHoldSchema = z
  .strictObject({
    id: uuid,
    workspaceId: uuid,
    scopeKind: holdScopeKindSchema,
    scopeKey: z.string().max(200).nullable(),
    reasonCode: holdReasonCodeSchema,
    blockedActionKinds: z.array(blockedActionKindSchema).min(1),
    sourceEventKind: z.string().trim().min(1).max(80),
    sourceEventId: z.string().max(200).nullable(),
    ownerUserId: uuid.nullable(),
    startedAt: instant,
    releasedAt: instant.nullable(),
    recoveryAction: holdRecoveryActionSchema.nullable(),
  })
  .refine(row => (row.scopeKind === 'workspace') === (row.scopeKey === null), 'a workspace hold names no scope key');

export const RETENTION_DATA_KINDS = [
  'business_records',
  'suppression_history',
  'audit_events',
  'research_evidence',
  'unmatched_gmail_metadata',
  'raw_mime',
  'matched_message_body',
  'canceled_drafts',
  'operational_logs',
  'database_backups',
] as const;

const jobStateSchema = z.enum(['queued', 'running', 'retryable', 'done', 'dead']);

export const jobSchema = z
  .strictObject({
    id: uuid,
    workspaceId: uuid,
    kind: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().trim().min(1).max(200),
    state: jobStateSchema,
    runAt: instant,
    notBefore: instant,
    attemptCount: z.number().int().min(0),
    maxAttempts: z.number().int().min(1),
    leaseOwner: z.string().trim().min(1).max(120).nullable(),
    leaseExpiresAt: instant.nullable(),
    /** Bounded and redacted: an operator hint, never a message body. */
    errorDetail: z.string().max(2000).nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .refine(
    row => (row.state === 'running') === (row.leaseOwner !== null && row.leaseExpiresAt !== null),
    'a running job holds a lease and nothing else does',
  );

export const heartbeatSchema = z
  .strictObject({
    id: uuid,
    workspaceId: uuid.nullable(),
    component: z.enum(['api', 'scheduler', 'worker', 'mailbox']),
    instanceKey: z.string().trim().min(1).max(200),
    observedAt: instant,
    detail: z.record(z.string(), z.unknown()),
  })
  .refine(
    row => (row.component === 'mailbox') === (row.workspaceId !== null),
    'a mailbox heartbeat is a workspace\'s; a service heartbeat is not',
  );
