import { z } from 'zod';
import {
  authenticationPasses,
  decideDomainGuard,
  effectiveDailyCap,
  outboundDoubtCounts,
  personalGmailRecipientsInWindow,
  readFence,
  readFenceEvents,
  readPrimarySendingDomain,
  readRamp,
  recordAuthenticationChecklist,
  registerSendingDomain,
  resolveUnknownTerminal,
  setAdminCap,
  setAutomatedSendingEnabled,
  type SendingDomainRow,
} from '@fss/domain/outbound';
import {
  REFUSAL_STATUS,
  contextForPrincipal,
  mailRouteDeps,
  redactError,
  runMailCommand,
} from './mailSupport.ts';
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
 *   * `/outbound/cap` — 12.7's "Admins may lower caps ... they may raise a mailbox
 *     to 75";
 *   * `/outbound/domain` — registers a sending domain (lane g57), so a workspace whose
 *     mailbox connected before the connect path registered one has somewhere to
 *     record the checklist. Idempotent: an existing row comes back unchanged, and the
 *     primary is never moved;
 *   * `/outbound/status` — what the ramp, the guard and the doubt look like now.
 *
 * All of them are `POST`, including the read, for the reason in
 * `docs/decisions/g3b-reads-are-posts.md`.
 *
 * ## Admin only, and the refusal says nothing
 *
 * Each of the commands is an admin decision with real consequences — marking a
 * send delivered continues a sequence; enabling authentication opens the sending
 * gate; raising a cap increases volume against somebody's domain reputation;
 * registering a domain decides which name the checklist is recorded against. A
 * salesperson gets `forbidden` with no detail, because which mailbox exists, which
 * domain is registered and what state a fence is in are not theirs to learn by
 * probing.
 */

export const OUTBOUND_PATHS: readonly string[] = [
  '/outbound/resolve',
  '/outbound/authentication',
  '/outbound/cap',
  '/outbound/domain',
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
    /** 12.7: "they may raise a mailbox to 75". Above that is refused, not clamped. */
    raiseTo: z.number().int().min(1).max(100).nullable().optional(),
  })
  .strict();

const domainCommandSchema = z
  .object({
    ...commandEnvelope,
    /** A domain, not an address: `registerSendingDomain` refuses an `@`, a scheme or a path. */
    domain: z.string().trim().min(3).max(253),
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
    return await runMailCommand(
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
    return await runMailCommand(
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
    return await runMailCommand(deps, capCommandSchema, 'set_mailbox_cap', async (context, body) => {
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

  if (request.path === '/outbound/domain') {
    return await runMailCommand(deps, domainCommandSchema, 'register_sending_domain', async (context, body) => {
      const registered = await registerSendingDomain(context, { domain: body.domain, registeredBy: 'admin' });
      if (!registered.ok) return { ok: false, reason: registered.reason };
      return {
        ok: true,
        value: {
          ...describeDomain(registered.domain),
          isPrimary: registered.domain.isPrimary,
          // `existing` is an answer, not a refusal: the row the admin asked for is
          // there, and it came back exactly as it was.
          outcome: registered.outcome,
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
  const recipients = await personalGmailRecipientsInWindow(context);

  const ramp =
    parsed.data.mailboxId === undefined ? null : await readRamp(context, parsed.data.mailboxId);
  const fence =
    parsed.data.outboundMessageId === undefined
      ? null
      : await readFence(context, parsed.data.outboundMessageId);

  return {
    status: 200,
    body: {
      domain: domain === null ? null : describeDomain(domain),
      guard:
        domain === null
          ? null
          : await decideDomainGuard(context, {
              // The headroom question, asked of a personal Gmail recipient, because
              // that is the only recipient the guard applies to.
              recipientAddress: 'headroom@gmail.com',
              domain,
            }),
      personalGmailRecipients: recipients,
      doubt,
      ramp:
        ramp === null
          ? null
          : {
              mailboxId: ramp.mailboxId,
              healthySendingDays: ramp.healthySendingDays,
              effectiveCap: effectiveDailyCap(ramp),
              adminDailyCap: ramp.adminDailyCap,
              raisedDailyCap: ramp.raisedDailyCap,
              lastHealthFailure: ramp.lastHealthFailure,
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
    personalGmailGuardPer24h: domain.personalGmailGuardPer24h,
    replyOnlyOptOut: domain.replyOnlyOptOut,
  };
}

