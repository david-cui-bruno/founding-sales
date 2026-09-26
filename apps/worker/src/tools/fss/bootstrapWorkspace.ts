import { withTransaction, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { isKnownTimeZone } from '@fss/domain/src/rules/localClock.ts';
import { normalizeSendingDomain, registerSendingDomain } from '@fss/domain/outbound/domainGuard.ts';
import { PROVISIONAL_GOOGLE_SUB_PREFIX, provisionalGoogleSub } from '@fss/contracts';

/**
 * `fss admin workspace bootstrap` — the first workspace and its first admin.
 *
 * ## The gap this closes
 *
 * Until this command there was no path by which the first workspace and the first
 * membership could come to exist. `apps/api/src/auth/signIn.ts` refuses a sign-in with
 * `workspace_unknown` unless the `workspaces` row is already there, and with
 * `membership_required` unless an **active** `workspace_memberships` row is already
 * there for the user — while the `users` row itself is only created at the end of a
 * successful sign-in. Three rows, each of which the others presuppose, and nothing in
 * `apps/` or `packages/` inserted the first of them: `grep 'INSERT INTO workspaces'`
 * found tests and nothing else.
 *
 * The eighth full rehearsal (run 35919040315, 23 September 2026) is where that became
 * visible from outside. Create, fill, the whole deploy path and the schema-range
 * refusals passed for the first time; the production smoke then failed after ten
 * minutes because no `CanaryCompletionAgeSeconds` datapoint had ever been published.
 * `apps/worker/src/scheduler/sources.ts` inserts one canary **per workspace**
 * (`SELECT id FROM workspaces`), so an environment with no workspace row runs a
 * scheduler that correctly has nothing to do, publishes no datapoint, and breaches the
 * `canary_stale` alarm — which is `treat_missing_data = breaching` on purpose.
 *
 * ## Why the admin's `users` row is written before that person exists to Google
 *
 * `users.google_sub` is the durable identity and it is `NOT NULL UNIQUE`. Google mints
 * it, it is a decimal string of digits, and nothing outside a signed id token may
 * assert one — so the real value is unknowable at bootstrap time. The row is therefore
 * written with the sentinel `PROVISIONAL_GOOGLE_SUB_PREFIX` and the lowercased e-mail
 * after it, and the first successful sign-in with that e-mail replaces the sentinel
 * with the real `sub` (`apps/api/src/auth/signIn.ts`, `auth.provisional_user_adopted`).
 * The prefix is one exported constant in `@fss/contracts` because two copies of it are
 * two facts that can disagree, and the disagreement would be a workspace whose admin
 * can never sign in.
 *
 * ## The sending domain, when it is asked for
 *
 * `--sending-domain <domain>` registers the workspace's sending domain in the same
 * transaction, through `registerSendingDomain` — the function the Gmail callback calls
 * when a mailbox connects. It exists for the workspace whose mailbox connected before
 * that callback registered anything: production's `callie`, whose Administration
 * screen read "No sending domain is configured." with the admin's DNS already passing.
 * It is idempotent in the way the rest of this command is: a domain already registered
 * is reported `existing` and left exactly as it was, checklist and all, so the flag can
 * ride on every re-run of 5.1a. The row is primary only if the workspace has none.
 *
 * ## What it is not
 *
 * It is not a way to grant access. It writes what an operator holding the runtime
 * database credential could already write by hand, and does it in one transaction with
 * the shapes validated first and an `audit_events` row afterwards. Membership is still
 * checked at the callback, again at the claim and again on every command; a provisional
 * row on its own authenticates nobody, because nothing can present an id token for it.
 */

export type BootstrapRefusal =
  | 'slug_invalid'
  | 'display_name_invalid'
  | 'admin_email_invalid'
  | 'admin_email_ambiguous'
  | 'time_zone_invalid'
  | 'sending_domain_invalid'
  | 'sending_domain_personal_gmail';

export type WorkspaceOutcome = 'created' | 'existing';
export type AdminOutcomeKind = 'provisional_created' | 'provisional_existing' | 'adopted_user';
export type MembershipOutcome = 'created' | 'existing' | 'reactivated';

export interface BootstrapReport {
  readonly workspace: {
    readonly id: string;
    readonly slug: string;
    readonly displayName: string;
    readonly businessTimeZone: string;
    readonly outcome: WorkspaceOutcome;
  };
  readonly admin: {
    readonly userId: string;
    readonly email: string;
    readonly outcome: AdminOutcomeKind;
  };
  readonly membership: {
    readonly role: 'admin';
    readonly outcome: MembershipOutcome;
  };
  /** Null when `--sending-domain` was not given. */
  readonly sendingDomain: {
    readonly domain: string;
    readonly isPrimary: boolean;
    readonly outcome: 'created' | 'existing';
  } | null;
}

export type BootstrapResult =
  | { readonly ok: true; readonly value: BootstrapReport }
  | { readonly ok: false; readonly reason: BootstrapRefusal; readonly detail: string };

export interface BootstrapOptions {
  readonly slug: string;
  readonly displayName: string;
  readonly adminEmail: string;
  /** Optional. `America/New_York` is what migration 0001 defaults the column to. */
  readonly timeZone?: string | undefined;
  /** Optional. Registered through `registerSendingDomain`, idempotently. */
  readonly sendingDomain?: string | undefined;
}

/** The workspace slug, exactly as `workspaces_slug_shape` in migration 0001 spells it. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/u;
/** The e-mail shape, exactly as `users_email_shape` in migration 0001 spells it. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
/** The IANA shape `workspaces_business_time_zone_shape` allows. `Intl` then decides. */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/u;

export const DEFAULT_BUSINESS_TIME_ZONE = 'America/New_York';

/**
 * How long an e-mail may be here, and why it is shorter than the column allows.
 *
 * `users.email` has no length limit in SQL, but the sentinel `google_sub` is the
 * prefix plus this e-mail and `users_google_sub_present` caps `google_sub` at 255. A
 * refusal naming the limit is better than an insert refused by a constraint whose
 * message says nothing about e-mail.
 */
const MAX_EMAIL_LENGTH = 200;

interface ValidatedInput {
  readonly slug: string;
  readonly displayName: string;
  readonly email: string;
  readonly timeZone: string;
  readonly sendingDomain: string | null;
}

/**
 * Who the sending-domain registration acts as. An operator at a command line is not a
 * user, and `audit_events.actor_kind` has no `operator`, so the scope is the system's —
 * `system`, the same actor the bootstrap's own audit row names.
 */
const OPERATOR_ACTOR = { kind: 'system', component: 'migration' } as const;

/**
 * Every shape, before a statement is sent.
 *
 * The database would refuse each of these too, and that is the point of doing it here:
 * a `CHECK` violation arrives as a failure (exit 21) naming a constraint, and an
 * operator who mistyped a slug at three in the morning needs a refusal (exit 20) that
 * names the flag and the rule.
 */
function validate(options: BootstrapOptions): ValidatedInput | { readonly refusal: BootstrapResult } {
  const slug = options.slug.trim();
  if (!SLUG.test(slug)) {
    return {
      refusal: {
        ok: false,
        reason: 'slug_invalid',
        detail: `--slug takes 2 to 63 characters matching ${SLUG.source}; '${slug}' does not`,
      },
    };
  }

  const displayName = options.displayName.trim();
  if (displayName.length === 0 || displayName.length > 200) {
    return {
      refusal: {
        ok: false,
        reason: 'display_name_invalid',
        detail: '--display-name takes 1 to 200 characters that are not all whitespace',
      },
    };
  }

  const email = options.adminEmail.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > MAX_EMAIL_LENGTH) {
    return {
      refusal: {
        ok: false,
        reason: 'admin_email_invalid',
        detail: `--admin-email takes one address of at most ${String(MAX_EMAIL_LENGTH)} characters in the shape the users_email_shape constraint accepts`,
      },
    };
  }

  const timeZone = (options.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE).trim();
  // Shape first, because the column has a CHECK for it; then `Intl`, which is the only
  // thing that knows whether the catalogue has the name. A catalogue lookup cannot be
  // a CHECK, which is why `@fss/domain` owns this half everywhere else too.
  if (!ZONE_SHAPE.test(timeZone) || !isKnownTimeZone(timeZone)) {
    return {
      refusal: {
        ok: false,
        reason: 'time_zone_invalid',
        detail: `--time-zone takes an IANA name this runtime's Intl knows; '${timeZone}' is not one`,
      },
    };
  }

  let sendingDomain: string | null = null;
  if (options.sendingDomain !== undefined) {
    const normalized = normalizeSendingDomain(options.sendingDomain);
    if (!normalized.ok) {
      return {
        refusal:
          normalized.reason === 'personal_gmail_domain'
            ? {
                ok: false,
                reason: 'sending_domain_personal_gmail',
                detail:
                  '--sending-domain names a personal Gmail domain; 12.6 treats gmail.com and googlemail.com as a recipient class, and nobody at Callie can attest to their DNS',
              }
            : {
                ok: false,
                reason: 'sending_domain_invalid',
                detail:
                  '--sending-domain takes a host name such as usecallie.com: no @, no scheme, no path, in the shape the sending_domains_domain_shape constraint accepts',
              },
      };
    }
    sendingDomain = normalized.domain;
  }

  return { slug, displayName, email, timeZone, sendingDomain };
}

interface WorkspaceRow {
  readonly id: string;
  readonly display_name: string;
  readonly business_time_zone: string;
  readonly [column: string]: unknown;
}

interface UserRow {
  readonly id: string;
  readonly google_sub: string;
  readonly [column: string]: unknown;
}

interface MembershipRow {
  readonly status: string;
  readonly role: string;
  readonly [column: string]: unknown;
}

/**
 * A refusal decided *inside* the transaction.
 *
 * `withTransaction` rolls back on a throw and commits on a return, so a refusal that
 * returned would keep the workspace row the same transaction had just inserted — a
 * command that refused and changed the database, which is the one outcome an operator
 * cannot reason about. Only `admin_email_ambiguous` can happen this late; it is thrown
 * here and turned back into a refusal below.
 */
class BootstrapRefusalError extends Error {
  constructor(
    readonly reason: BootstrapRefusal,
    readonly detail: string,
  ) {
    super(reason);
    this.name = 'BootstrapRefusalError';
  }
}

export async function bootstrapWorkspace(
  session: SessionQueryable,
  options: BootstrapOptions,
): Promise<BootstrapResult> {
  const validated = validate(options);
  if ('refusal' in validated) return validated.refusal;
  const { slug, displayName, email, timeZone, sendingDomain } = validated;

  try {
    return await withTransaction(session, async (): Promise<BootstrapResult> => {
      // ---- the workspace -----------------------------------------------------
      //
      // Selected by slug rather than upserted, because the report has to say which of
      // the two happened and `ON CONFLICT DO UPDATE` would rename a workspace somebody
      // else created under this slug. A re-run names the existing one and changes
      // nothing about it.
      const found = await session.query<WorkspaceRow>(
        'SELECT id, display_name, business_time_zone FROM workspaces WHERE slug = $1',
        [slug],
      );
      let workspace = found.rows[0];
      const workspaceOutcome: WorkspaceOutcome = workspace === undefined ? 'created' : 'existing';
      if (workspace === undefined) {
        const created = await session.query<WorkspaceRow>(
          `INSERT INTO workspaces (slug, display_name, business_time_zone)
           VALUES ($1, $2, $3)
           RETURNING id, display_name, business_time_zone`,
          [slug, displayName, timeZone],
        );
        workspace = created.rows[0];
      }
      if (workspace === undefined) {
        // Unreachable through PostgreSQL: an INSERT ... RETURNING that inserted a row
        // returns it. Asserted rather than assumed, because the alternative is a report
        // naming an empty workspace id as if it were one.
        throw new Error('the workspace row was neither found nor returned by its insert');
      }
      const workspaceId = workspace.id;

      // ---- the admin user ----------------------------------------------------
      //
      // `users.email` is deliberately not unique (two Callie people may share an alias,
      // and a changed address must not create a second account), so this reads every row
      // with the address and decides between them by `google_sub`:
      //
      //   * exactly one row with a *real* sub — that person has signed in, and the
      //     membership belongs to the account they already have;
      //   * more than one — nothing here may pick, so it refuses and says so;
      //   * the sentinel row — a previous run of this command, so this one is a re-run;
      //   * nothing at all — write the sentinel row.
      const sentinel = provisionalGoogleSub(email);
      const existing = await session.query<UserRow>(
        'SELECT id, google_sub FROM users WHERE email = $1 ORDER BY created_at, id',
        [email],
      );
      const real = existing.rows.filter(row => !row.google_sub.startsWith(PROVISIONAL_GOOGLE_SUB_PREFIX));
      const provisional = existing.rows.find(row => row.google_sub === sentinel);

      let userId: string;
      let adminOutcome: AdminOutcomeKind;
      if (real.length > 1) {
        throw new BootstrapRefusalError(
          'admin_email_ambiguous',
          `${String(real.length)} users rows carry this address with a real Google sub, so which of them the first admin is cannot be decided here`,
        );
      } else if (real[0] !== undefined) {
        userId = real[0].id;
        adminOutcome = 'adopted_user';
      } else if (provisional !== undefined) {
        userId = provisional.id;
        adminOutcome = 'provisional_existing';
      } else {
        const localPart = email.slice(0, email.indexOf('@'));
        const inserted = await session.query<UserRow>(
          `INSERT INTO users (google_sub, email, display_name)
           VALUES ($1, $2, $3)
           RETURNING id, google_sub`,
          [sentinel, email, localPart],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('the provisional users row was not returned by its insert');
        userId = row.id;
        adminOutcome = 'provisional_created';
      }

      // ---- the membership ----------------------------------------------------
      //
      // Active `admin`, and the only one of the three rows that is access. An inactive
      // row is reactivated rather than left alone: `workspace_memberships_one_per_user`
      // means there is nowhere else to put the grant, and a bootstrap that silently did
      // nothing because somebody had been deactivated is a workspace nobody can enter
      // with a report that says everything is fine.
      //
      // Reaching that state takes a second admin, because
      // `workspace_memberships_last_active_admin` (migration 0001) refuses any update
      // that would leave a workspace with none — so the row this reactivates was
      // always deactivated while somebody else held the role.
      const membership = await session.query<MembershipRow>(
        'SELECT role, status FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId],
      );
      const held = membership.rows[0];
      let membershipOutcome: MembershipOutcome;
      if (held === undefined) {
        await session.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
           VALUES ($1, $2, 'admin', 'active')`,
          [workspaceId, userId],
        );
        membershipOutcome = 'created';
      } else if (held.status !== 'active' || held.role !== 'admin') {
        await session.query(
          `UPDATE workspace_memberships
              SET role = 'admin', status = 'active', deactivated_at = NULL, updated_at = now()
            WHERE workspace_id = $1 AND user_id = $2`,
          [workspaceId, userId],
        );
        membershipOutcome = 'reactivated';
      } else {
        membershipOutcome = 'existing';
      }

      // ---- the sending domain, when asked for ---------------------------------
      //
      // After the membership, in the same transaction, so a refusal or a failure here
      // leaves none of the rows above behind. `registerSendingDomain` writes its own
      // `sending_domain.registered` audit row when it inserts, and changes nothing when
      // the domain is already there.
      let sendingDomainReport: BootstrapReport['sendingDomain'] = null;
      if (sendingDomain !== null) {
        const context = repositoryContext(workspaceScope(workspaceId, OPERATOR_ACTOR), session);
        const registered = await registerSendingDomain(context, { domain: sendingDomain, registeredBy: 'operator' });
        if (!registered.ok) {
          // Unreachable: `validate` normalized the same value with the same function.
          throw new BootstrapRefusalError(
            registered.reason === 'personal_gmail_domain' ? 'sending_domain_personal_gmail' : 'sending_domain_invalid',
            `registerSendingDomain refused with ${registered.reason}`,
          );
        }
        sendingDomainReport = {
          domain: registered.domain.domain,
          isPrimary: registered.domain.isPrimary,
          outcome: registered.outcome,
        };
      }

      // ---- the audit row -----------------------------------------------------
      //
      // `audit_events.actor_kind` is one of `user`, `admin`, `system`, `worker`
      // (migration 0001) and `audit_events_user_actor_identified` requires a user id for
      // the first two. An operator at a command line is none of those four, so the
      // actor is `system` and the command is named in the detail — which carries the
      // three outcomes and no e-mail address, because a detail never carries one.
      await session.query(
        `INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
         VALUES ($1, 'system', NULL, 'workspace.bootstrapped', 'workspace', $2, $3::jsonb)`,
        [
          workspaceId,
          workspaceId,
          JSON.stringify({
            command: 'fss admin workspace bootstrap',
            workspace: workspaceOutcome,
            admin: adminOutcome,
            membership: membershipOutcome,
            role: 'admin',
            adminUserId: userId,
            sendingDomain: sendingDomainReport?.outcome ?? null,
          }),
        ],
      );

      return {
        ok: true,
        value: {
          workspace: {
            id: workspaceId,
            slug,
            displayName: workspace.display_name,
            businessTimeZone: workspace.business_time_zone,
            outcome: workspaceOutcome,
          },
          admin: { userId, email, outcome: adminOutcome },
          membership: { role: 'admin', outcome: membershipOutcome },
          sendingDomain: sendingDomainReport,
        },
      };
    });
  } catch (error) {
    if (error instanceof BootstrapRefusalError) {
      return { ok: false, reason: error.reason, detail: error.detail };
    }
    throw error;
  }
}
