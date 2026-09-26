import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import { payloadHash } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0003 adds (sessions,
 * device refresh credentials, one-time OpenID Connect authorization requests, and
 * one command id per workspace).
 *
 * They live in their own file, appended to `cases` in constraints.test.ts, so two
 * lanes adding migrations at the same time do not both edit the middle of that
 * array. The coverage test at the bottom of constraints.test.ts is what makes them
 * mandatory: a constraint with no case here fails the build.
 */

export interface IdentityCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
}

export interface IdentityCase {
  readonly constraint: string;
  readonly run: (fixture: IdentityCaseFixture) => Promise<unknown>;
}

const workspace = (f: IdentityCaseFixture): string => f.seeded.alpha.workspaceId;
const user = (f: IdentityCaseFixture): string => f.seeded.alpha.salesperson.userId;
const device = (f: IdentityCaseFixture): string => f.seeded.alpha.salesperson.deviceId;

/** A well-formed session row, so a case only has to change the one column it is about. */
const SESSION_COLUMNS =
  'workspace_id, user_id, device_id, access_token_hash, expires_at, reauthenticate_after';
const SESSION_TIMES = "now() + interval '1 hour', now() + interval '30 days'";

async function insertSession(
  f: IdentityCaseFixture,
  overrides: { readonly tokenSeed?: string; readonly extraColumns?: string; readonly extraValues?: string } = {},
): Promise<{ id: string }> {
  const columns = `${SESSION_COLUMNS}${overrides.extraColumns ?? ''}`;
  const values = `$1, $2, $3, $4, ${SESSION_TIMES}${overrides.extraValues ?? ''}`;
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO sessions (${columns}) VALUES (${values}) RETURNING id`,
    [workspace(f), user(f), device(f), payloadHash(overrides.tokenSeed ?? 'session')],
  );
  return { id: rows[0]?.id ?? '' };
}

async function insertCredential(
  f: IdentityCaseFixture,
  generation: number,
  state = 'active',
): Promise<void> {
  await f.session.query(
    `INSERT INTO device_refresh_credentials (workspace_id, device_id, generation, secret_hash, state, expires_at, used_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days', CASE WHEN $5 = 'rotated' THEN now() ELSE NULL END)`,
    [workspace(f), device(f), generation, payloadHash(`credential-${String(generation)}`), state],
  );
}

const REQUEST_COLUMNS =
  'state_hash, workspace_id, nonce_hash, handoff_hash, code_challenge, device_label, client_version, expires_at';

async function insertRequest(
  f: IdentityCaseFixture,
  seed: string,
  overrides: { readonly extraColumns?: string; readonly extraValues?: string } = {},
): Promise<void> {
  await f.session.query(
    `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS}${overrides.extraColumns ?? ''})
     VALUES ($1, $2, $3, $4, $5, 'A Mac', '1.4.0', now() + interval '10 minutes'${overrides.extraValues ?? ''})`,
    [
      payloadHash(`state-${seed}`),
      workspace(f),
      payloadHash(`nonce-${seed}`),
      payloadHash(`handoff-${seed}`),
      'A'.repeat(43),
    ],
  );
}

export const IDENTITY_CONSTRAINT_CASES: readonly IdentityCase[] = [
  // ------------------------------------------------------------------ sessions
  {
    constraint: 'sessions_pkey',
    run: async f => {
      const first = await insertSession(f, { tokenSeed: 'pkey-one' });
      return await f.session.query(
        `INSERT INTO sessions (id, ${SESSION_COLUMNS}) VALUES ($5, $1, $2, $3, $4, ${SESSION_TIMES})`,
        [workspace(f), user(f), device(f), payloadHash('pkey-two'), first.id],
      );
    },
  },
  {
    constraint: 'sessions_token_unique',
    run: async f => {
      await insertSession(f, { tokenSeed: 'shared-token' });
      return await insertSession(f, { tokenSeed: 'shared-token' });
    },
  },
  {
    constraint: 'sessions_device_fkey',
    run: async f =>
      // Beta's device inside alpha's workspace: the composite key refuses the crossing.
      await f.session.query(
        `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, ${SESSION_TIMES})`,
        [workspace(f), user(f), f.seeded.beta.salesperson.deviceId, payloadHash('cross-device')],
      ),
  },
  {
    constraint: 'sessions_membership_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, ${SESSION_TIMES})`,
        [workspace(f), f.seeded.beta.salesperson.userId, device(f), payloadHash('cross-member')],
      ),
  },
  {
    constraint: 'sessions_token_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES ($1, $2, $3, 'a-plaintext-token', ${SESSION_TIMES})`,
        [workspace(f), user(f), device(f)],
      ),
  },
  {
    constraint: 'sessions_client_version_shape',
    run: async f =>
      await insertSession(f, { tokenSeed: 'bad-version', extraColumns: ', client_version', extraValues: ", 'v1'" }),
  },
  {
    constraint: 'sessions_status_known',
    run: async f =>
      await insertSession(f, { tokenSeed: 'bad-status', extraColumns: ', status', extraValues: ", 'sleeping'" }),
  },
  {
    constraint: 'sessions_end_consistent',
    run: async f =>
      await insertSession(f, {
        tokenSeed: 'ended-no-instant',
        extraColumns: ', status, end_reason',
        extraValues: ", 'ended', 'signed_out'",
      }),
  },
  {
    constraint: 'sessions_end_reason_consistent',
    run: async f =>
      await insertSession(f, {
        tokenSeed: 'ended-no-reason',
        extraColumns: ', status, ended_at',
        extraValues: ', \'ended\', now()',
      }),
  },
  {
    constraint: 'sessions_end_reason_known',
    run: async f =>
      await insertSession(f, {
        tokenSeed: 'bad-reason',
        extraColumns: ', status, ended_at, end_reason',
        extraValues: ", 'ended', now(), 'felt_like_it'",
      }),
  },
  {
    constraint: 'sessions_expiry_after_issue',
    run: async f =>
      await f.session.query(
        `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '30 days')`,
        [workspace(f), user(f), device(f), payloadHash('backwards-expiry')],
      ),
  },
  {
    constraint: 'sessions_reauthentication_not_before_expiry',
    run: async f =>
      await f.session.query(
        `INSERT INTO sessions (${SESSION_COLUMNS}) VALUES ($1, $2, $3, $4, now() + interval '1 hour', now() + interval '10 minutes')`,
        [workspace(f), user(f), device(f), payloadHash('short-reauth')],
      ),
  },

  // -------------------------------------------------- device_refresh_credentials
  {
    constraint: 'device_refresh_credentials_pkey',
    run: async f => {
      await insertCredential(f, 1, 'rotated');
      return await insertCredential(f, 1, 'rotated');
    },
  },
  {
    constraint: 'device_refresh_credentials_one_active',
    run: async f => {
      await insertCredential(f, 1);
      return await insertCredential(f, 2);
    },
  },
  {
    constraint: 'device_refresh_credentials_device_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO device_refresh_credentials (workspace_id, device_id, generation, secret_hash, expires_at)
         VALUES ($1, $2, 1, $3, now() + interval '30 days')`,
        [workspace(f), f.seeded.beta.salesperson.deviceId, payloadHash('cross-credential')],
      ),
  },
  {
    constraint: 'device_refresh_credentials_secret_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO device_refresh_credentials (workspace_id, device_id, generation, secret_hash, expires_at)
         VALUES ($1, $2, 1, 'a-plaintext-credential', now() + interval '30 days')`,
        [workspace(f), device(f)],
      ),
  },
  {
    constraint: 'device_refresh_credentials_generation_positive',
    run: async f => await insertCredential(f, 0),
  },
  {
    constraint: 'device_refresh_credentials_state_known',
    run: async f => await insertCredential(f, 1, 'retired'),
  },
  {
    constraint: 'device_refresh_credentials_use_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO device_refresh_credentials (workspace_id, device_id, generation, secret_hash, state, expires_at)
         VALUES ($1, $2, 1, $3, 'rotated', now() + interval '30 days')`,
        [workspace(f), device(f), payloadHash('rotated-unused')],
      ),
  },
  {
    constraint: 'device_refresh_credentials_expiry_after_issue',
    run: async f =>
      await f.session.query(
        `INSERT INTO device_refresh_credentials (workspace_id, device_id, generation, secret_hash, expires_at)
         VALUES ($1, $2, 1, $3, now() - interval '1 day')`,
        [workspace(f), device(f), payloadHash('expired-on-arrival')],
      ),
  },

  // ------------------------------------------- oidc_authorization_requests
  {
    constraint: 'oidc_authorization_requests_pkey',
    run: async f => {
      await insertRequest(f, 'same-state');
      // A second row with the same state hash but a different handoff hash.
      return await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, 'A Mac', '1.4.0', now() + interval '10 minutes')`,
        [
          payloadHash('state-same-state'),
          workspace(f),
          payloadHash('nonce-other'),
          payloadHash('handoff-other'),
          'B'.repeat(43),
        ],
      );
    },
  },
  {
    constraint: 'oidc_authorization_requests_handoff_unique',
    run: async f => {
      await insertRequest(f, 'handoff-one');
      return await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, 'A Mac', '1.4.0', now() + interval '10 minutes')`,
        [
          payloadHash('state-handoff-two'),
          workspace(f),
          payloadHash('nonce-handoff-two'),
          payloadHash('handoff-handoff-one'),
          'C'.repeat(43),
        ],
      );
    },
  },
  {
    constraint: 'oidc_authorization_requests_workspace_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, '00000000-0000-4000-8000-000000000000', $2, $3, $4, 'A Mac', '1.4.0', now() + interval '10 minutes')`,
        [payloadHash('state-no-workspace'), payloadHash('nonce-x'), payloadHash('handoff-x'), 'D'.repeat(43)],
      ),
  },
  {
    constraint: 'oidc_authorization_requests_user_fkey',
    run: async f =>
      await insertRequest(f, 'no-user', {
        extraColumns: ', status, user_id, resolved_at',
        extraValues: ", 'authenticated', '00000000-0000-4000-8000-000000000000', now()",
      }),
  },
  {
    constraint: 'oidc_authorization_requests_state_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ('a-plaintext-state', $1, $2, $3, $4, 'A Mac', '1.4.0', now() + interval '10 minutes')`,
        [workspace(f), payloadHash('nonce-y'), payloadHash('handoff-y'), 'E'.repeat(43)],
      ),
  },
  {
    constraint: 'oidc_authorization_requests_nonce_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, $2, 'a-plaintext-nonce', $3, $4, 'A Mac', '1.4.0', now() + interval '10 minutes')`,
        [payloadHash('state-z'), workspace(f), payloadHash('handoff-z'), 'F'.repeat(43)],
      ),
  },
  {
    constraint: 'oidc_authorization_requests_handoff_hash_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, $2, $3, 'a-plaintext-handoff', $4, 'A Mac', '1.4.0', now() + interval '10 minutes')`,
        [payloadHash('state-w'), workspace(f), payloadHash('nonce-w'), 'G'.repeat(43)],
      ),
  },
  {
    constraint: 'oidc_authorization_requests_code_challenge_shape',
    run: async f =>
      // The `plain` PKCE method, which this API never accepts.
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, $2, $3, $4, 'plain-verifier', 'A Mac', '1.4.0', now() + interval '10 minutes')`,
        [payloadHash('state-p'), workspace(f), payloadHash('nonce-p'), payloadHash('handoff-p')],
      ),
  },
  {
    constraint: 'oidc_authorization_requests_label_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, '   ', '1.4.0', now() + interval '10 minutes')`,
        [payloadHash('state-l'), workspace(f), payloadHash('nonce-l'), payloadHash('handoff-l'), 'H'.repeat(43)],
      ),
  },
  {
    constraint: 'oidc_authorization_requests_client_version_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, 'A Mac', 'latest', now() + interval '10 minutes')`,
        [payloadHash('state-v'), workspace(f), payloadHash('nonce-v'), payloadHash('handoff-v'), 'I'.repeat(43)],
      ),
  },
  {
    constraint: 'oidc_authorization_requests_status_known',
    run: async f =>
      await insertRequest(f, 'bad-status', {
        extraColumns: ', status, resolved_at',
        extraValues: ", 'half-done', now()",
      }),
  },
  {
    constraint: 'oidc_authorization_requests_expiry_after_creation',
    run: async f =>
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, 'A Mac', '1.4.0', now() - interval '1 minute')`,
        [payloadHash('state-e'), workspace(f), payloadHash('nonce-e'), payloadHash('handoff-e'), 'J'.repeat(43)],
      ),
  },
  {
    constraint: 'oidc_authorization_requests_resolution_consistent',
    run: async f =>
      // Still pending, but already carrying a resolution instant.
      await insertRequest(f, 'pending-resolved', { extraColumns: ', resolved_at', extraValues: ', now()' }),
  },
  {
    constraint: 'oidc_authorization_requests_user_present',
    run: async f =>
      await insertRequest(f, 'authenticated-anonymous', {
        extraColumns: ', status, resolved_at',
        extraValues: ", 'authenticated', now()",
      }),
  },
  {
    constraint: 'oidc_authorization_requests_failure_code_present',
    run: async f =>
      await insertRequest(f, 'failed-silently', {
        extraColumns: ', status, resolved_at',
        extraValues: ", 'failed', now()",
      }),
  },
  {
    constraint: 'oidc_authorization_requests_claim_consistent',
    run: async f =>
      // Claimed, by a real member, but with no instant recorded for the claim.
      await f.session.query(
        `INSERT INTO oidc_authorization_requests (${REQUEST_COLUMNS}, status, resolved_at, user_id)
         VALUES ($1, $2, $3, $4, $5, 'A Mac', '1.4.0', now() + interval '10 minutes', 'claimed', now(), $6)`,
        [
          payloadHash('state-c'),
          workspace(f),
          payloadHash('nonce-c'),
          payloadHash('handoff-c'),
          'K'.repeat(43),
          user(f),
        ],
      ),
  },

  // ----------------------------------------------------------- command_receipts
  {
    constraint: 'command_receipts_command_id_unique',
    run: async f => {
      for (const deviceId of [device(f), f.seeded.alpha.admin.deviceId]) {
        await f.session.query(
          "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-one-per-workspace', 'firm.assign', $3, 'accepted')",
          [workspace(f), deviceId, payloadHash('cmd')],
        );
      }
      return null;
    },
  },
];
