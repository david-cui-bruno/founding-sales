import { z } from 'zod';
import { overrideMailboxRaiseCommandSchema } from '@fss/contracts';
import {
  authenticationPasses,
  readPrimarySendingDomain,
  recordAuthenticationChecklist,
  setAutomatedSendingEnabled,
  type SendingDomainRow,
} from '@fss/domain/outbound/domainGuard.ts';
import { readFence, readFenceEvents, resolveUnknownTerminal } from '@fss/domain/outbound/fence.ts';
import { outboundDoubtCounts } from '@fss/domain/outbound/metrics.ts';
import { overrideRaise, readRampStanding, setAdminCap } from '@fss/domain/outbound/ramp.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { mailRouteDeps } from './mailSupport.ts';
import { contextForPrincipal, runRouteCommand } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The admin surfaces of at-most-once sending (specification 12.5, 12.7).
 *
 * Every one of them is a decision a person makes and the application cannot:
 *
 *   * `/outbound/resolve` — 12.5's "an admin may mark the result delivered or
 *     skipped" for a fence that ended `unknown_terminal`;
 *   * `/outbound/authentication` — 12.7's SPF, DKIM and DMARC checklist, which is a
 *     person saying they looked, because **this application never queries DNS**;
 *   * `/outbound/cap` — 12.7's "Admins may lower caps ... After sustained healthy
 *     results they may raise a mailbox to 75". The raise is refused, with the part of
 *     the rule not met, unless the mailbox has finished the schedule
 *     (`ramp_not_settled`) and kept its last ten closed sending days healthy
 *     (`health_not_sustained`) — audit S06. Unchanged for desktop 1.0.11;
 *   * `/outbound/cap/override` — wave 2 (S4.6): the admin raises a mailbox to any cap up
 *     to the ceiling of 100, or clears the raise, earned or not, and the answer's
 *     `warning` names the part of the rule not met. The daily cap is still enforced at
 *     every send;
 *   * `/outbound/status` — what the ramp and the doubt look like now.
 *
 * All of them are `POST`, including the read, for the reason in
 * `docs/decisions/g3b-reads-are-posts.md`.
 *
 * ## Admin only, and the refusal says nothing
 *
 * Each of the commands is an admin decision with real consequences — marking a
 * send delivered continues a sequence; enabling authentication opens the sending
 * gate; raising a cap increases volume against somebody's domain reputation. A
 * salesperson gets `forbidden` with no detail, because which mailbox exists, which
 * domain is registered and what state a fence is in are not theirs to learn by
 * probing.
 */

export const OUTBOUND_PATHS: readonly string[] = [
  '/outbound/resolve',
  '/outbound/authentication',
  '/outbound/cap',
  '/outbound/cap/override',
  '/outbound/status',
];

const commandEnvelope = {
  commandId: z.string().uuid(),
  clientVersion: z.string().min(1).max(32),
};

const resolveCommandSchema = z
  .object({
    ...commandEnvelope,
    outboundMessageId: z.string().uuid(),
    resolution: z.enum(['delivered', 'skipped']),
  })
  .strict();

const authenticationCommandSchema = z
  .object({
    ...commandEnvelope,
    domain: z.string().trim().min(3).max(253),
    spfPass: z.boolean(),
    dkimPass: z.boolean(),
    dmarcPass: z.boolean(),
    postmasterReviewed: z.boolean(),
    /** Whether automated sending is on. Refused unless the four above all pass. */
    automatedSendingEnabled: z.boolean(),
  })
  .strict();

const capCommandSchema = z
  .object({
    ...commandEnvelope,
    mailboxId: z.string().uuid(),
    /** 12.7: "Admins may lower caps." Null clears the lowering. */
    lowerTo: z.number().int().min(0).max(100).nullable().optional(),
    /**
     * 12.7: "After sustained healthy results they may raise a mailbox to 75". Above 75
     * is refused, not clamped (`raise_above_limit`); so is any raise the mailbox has
     * not earned (`ramp_not_settled`, `health_not_sustained`). Null clears the raise;
     * absent leaves it as it is.
     */
    raiseTo: z.number().int().min(1).max(100).nullable().optional(),
  })
  .strict();


const statusRequestSchema = z
  .object({ mailboxId: z.string().uuid().optional(), outboundMessageId: z.string().uuid().optional() })
  .strict();

export async function routeOutbound(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!OUTBOUND_PATHS.includes(request.path)) return null;
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const prepared = await mailRouteDeps(request, options);
  if (!prepared.ok) return prepared.result;
  const deps = prepared.deps;
  if (deps.principal.role !== 'admin') {
    // 403 with the same body every refusal here gets. `REFUSAL_STATUS` has no
    // `forbidden` entry because nothing before this lane needed one at the route
    // level; the number is written here rather than added to a shared map that other
    // lanes would then have to agree about.
    return { status: 403, body: redactError('not_found') };
  }

  if (request.path === '/outbound/resolve') {
    return await runRouteCommand(
      deps,
      resolveCommandSchema,
      'resolve_outbound_message',
      async (context, body) => {
        const outcome = await resolveUnknownTerminal(context, {
          outboundMessageId: body.outboundMessageId,
          resolution: body.resolution,
          adminUserId: deps.principal.userId,
        });
        if (!outcome.ok) return { ok: false, reason: outcome.reason };
        return {
          ok: true,
          value: {
            outboundMessageId: outcome.value.id,
            resolution: outcome.value.adminResolution,
            // 12.5: the successor's delay is computed from *this* instant, not from
            // the admin's. The client shows it so nobody has to guess.
            dispatchedAt: outcome.value.dispatchStartedAt,
            enrollmentId: outcome.value.enrollmentId,
          },
        };
      },
    );
  }

  if (request.path === '/outbound/authentication') {
    return await runRouteCommand(
      deps,
      authenticationCommandSchema,
      'record_sending_authentication',
      async (context, body) => {
        const recorded = await recordAuthenticationChecklist(context, {
          domain: body.domain,
          adminUserId: deps.principal.userId,
          spfPass: body.spfPass,
          dkimPass: body.dkimPass,
          dmarcPass: body.dmarcPass,
          postmasterReviewed: body.postmasterReviewed,
        });
        if (!recorded.ok) return { ok: false, reason: recorded.reason };
        if (!body.automatedSendingEnabled) {
          return { ok: true, value: describeDomain(recorded.domain) };
        }
        const enabled = await setAutomatedSendingEnabled(context, {
          domain: body.domain,
          enabled: true,
        });
        if (!enabled.ok) return { ok: false, reason: enabled.reason };
        return { ok: true, value: describeDomain(enabled.domain) };
      },
    );
  }

  if (request.path === '/outbound/cap') {
    return await runRouteCommand(deps, capCommandSchema, 'set_mailbox_cap', async (context, body) => {
      const outcome = await setAdminCap(context, {
        mailboxId: body.mailboxId,
        adminUserId: deps.principal.userId,
        ...(body.lowerTo === undefined ? {} : { lowerTo: body.lowerTo }),
        ...(body.raiseTo === undefined ? {} : { raiseTo: body.raiseTo }),
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      return {
        ok: true,
        value: {
          mailboxId: body.mailboxId,
          effectiveCap: outcome.effectiveCap,
          healthySendingDays: outcome.ramp.healthySendingDays,
        },
      };
    });
  }

  if (request.path === '/outbound/cap/override') {
    return await runRouteCommand(deps, overrideMailboxRaiseCommandSchema, 'override_mailbox_raise', async (context, body) => {
      const outcome = await overrideRaise(context, {
        mailboxId: body.mailboxId,
        adminUserId: deps.principal.userId,
        raiseTo: body.raiseTo,
      });
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      return {
        ok: true,
        value: {
          mailboxId: body.mailboxId,
          effectiveCap: outcome.effectiveCap,
          raisedDailyCap: outcome.ramp.raisedDailyCap,
          healthySendingDays: outcome.ramp.healthySendingDays,
          warning: outcome.warning,
        },
      };
    });
  }

  // ------------------------------------------------------------------- status
  const parsed = statusRequestSchema.safeParse(request.body ?? {});
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const scoped = contextForPrincipal(deps.auth, deps.principal);
  if (!scoped.ok) return scoped.result;
  const context = scoped.context;

  const domain = await readPrimarySendingDomain(context);
  const doubt = await outboundDoubtCounts(context.db);

  // The cap in force — the number the gate enforces — and the ramp's columns.
  const standing =
    parsed.data.mailboxId === undefined ? null : await readRampStanding(context, parsed.data.mailboxId);
  const fence =
    parsed.data.outboundMessageId === undefined
      ? null
      : await readFence(context, parsed.data.outboundMessageId);

  return {
    status: 200,
    body: {
      domain: domain === null ? null : describeDomain(domain),
      // Deprecated: the personal-Gmail guard was deleted on 26 Sep 2026. Desktops up to
      // 1.0.10 parse `guard` and `personalGmailRecipients` as required, so both are
      // constants that always pass until wave 2 removes them from the contract.
      guard: domain === null ? null : DEPRECATED_GUARD_DECISION,
      personalGmailRecipients: DEPRECATED_PERSONAL_GMAIL_RECIPIENTS,
      doubt,
      ramp:
        standing === null
          ? null
          : {
              mailboxId: standing.ramp.mailboxId,
              healthySendingDays: standing.ramp.healthySendingDays,
              effectiveCap: standing.effectiveCap,
              adminDailyCap: standing.ramp.adminDailyCap,
              raisedDailyCap: standing.ramp.raisedDailyCap,
              lastHealthFailure: standing.ramp.lastHealthFailure,
            },
      fence:
        fence === null
          ? null
          : {
              id: fence.id,
              state: fence.state,
              // Never the subject or the body: this is an operational view, and
              // Appendix F puts message content behind the assignee or an admin on
              // the *firm*, which being a workspace admin does not establish.
              recipientAddress: fence.recipientAddress,
              dispatchStartedAt: fence.dispatchStartedAt,
              sentAt: fence.sentAt,
              heldReason: fence.heldReason,
              adminResolution: fence.adminResolution,
              reconcileAttempts: fence.reconcileAttempts,
              events: await readFenceEvents(context, fence.id),
            },
    },
  };
}

function describeDomain(domain: SendingDomainRow): Readonly<Record<string, unknown>> {
  return {
    domain: domain.domain,
    spfPass: domain.spfPass,
    dkimPass: domain.dkimPass,
    dmarcPass: domain.dmarcPass,
    postmasterReviewedAt: domain.postmasterReviewedAt,
    authenticationPasses: authenticationPasses(domain),
    automatedSendingEnabled: domain.automatedSendingEnabled,
    // Deprecated constants, for the same installed desktops as the guard below.
    personalGmailGuardPer24h: DEPRECATED_PERSONAL_GMAIL_GUARD,
    replyOnlyOptOut: true,
  };
}

/** The guard's old default; the installed desktop prints it and nothing enforces it. */
const DEPRECATED_PERSONAL_GMAIL_GUARD = 4000;

/** A guard decision that always allows: the guard no longer exists. */
const DEPRECATED_GUARD_DECISION = Object.freeze({
  allowed: true,
  applies: false,
  used: 0,
  guard: DEPRECATED_PERSONAL_GMAIL_GUARD,
  headroom: DEPRECATED_PERSONAL_GMAIL_GUARD,
});

const DEPRECATED_PERSONAL_GMAIL_RECIPIENTS = Object.freeze({ automated: 0, direct: 0, total: 0 });

