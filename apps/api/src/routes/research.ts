import {
  researchAddLinkCommandSchema,
  researchFirmRequestSchema,
  researchRunCommandSchema,
  researchSettingsCommandSchema,
} from '@fss/contracts';
import { readFirmForActor } from '@fss/domain/crm/dto.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { listFirmFacts, readCallBrief, readFirmJudgments } from '@fss/domain/research/brief.ts';
import { researchClearanceAvailable } from '@fss/domain/research/ceilings.ts';
import { enqueueFirmResearch } from '@fss/domain/research/enqueue.ts';
import { readSpend, workspaceBusinessZone } from '@fss/domain/research/ledger.ts';
import { addFirmLink, listFirmLinks } from '@fss/domain/research/links.ts';
import { worstCaseRunCents } from '@fss/domain/research/pricing.ts';
import { listRuns } from '@fss/domain/research/runs.ts';
import { updateResearchSettings } from '@fss/domain/research/settings.ts';
import type { RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { contextForPrincipal, requirePrincipal, runRouteCommand, type RouteDeps } from './routeSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * Research (`.context/DECISION-20260928-crm-design.md`, "Research"; David's answers
 * 5 and 8).
 *
 * Four exact paths, in their own module, which is what every new endpoint is
 * (`modules.ts`). A `/research` prefix would have let one claim answer for both the
 * read and the three commands, and the registry can only promise about the paths it
 * was told.
 *
 * **The read is a POST**, like every other read here: a firm id in a query string is
 * written to a load balancer's access log and quoted back in an error page.
 *
 * **The three commands go through `runCommand`.** The receipt, the payload hash, the
 * device and the mutation commit in one transaction (5.3), so a replayed click
 * returns the original result rather than queueing a second run. Refusals are values
 * with names, never exceptions.
 *
 * **Visibility is the firm page's.** `readFirmForActor` decides, not this file: an
 * assignee or an admin sees the research, and another active member gets the same
 * `not_found` a firm they are not assigned gets. A firm's quotes, its judgment and
 * what it cost are the shape of somebody else's work, and Appendix F's first row does
 * not grant them.
 *
 * The one thing this module does **not** do is touch `crmSurface.ts`'s
 * `z.strictObject` behind `pageVersion`. The desktop's Research section reads
 * `/research/firm` instead, so the firm page's contract stays exactly as it is.
 */

export const RESEARCH_PATHS: readonly string[] = [
  '/research/firm',
  '/research/firm/run',
  '/research/firm/links/add',
  '/research/settings',
];

/**
 * May this caller see research about this firm?
 *
 * `readFirmForActor` answers `any_active_member` for a colleague's firm, and the
 * answer here is the same `not_found` the Today card gives: telling a salesperson
 * that somebody else's firm has been researched is a read nobody granted.
 */
async function visibleFirm(context: RepositoryContext, firmId: string): Promise<boolean> {
  const read = await readFirmForActor(context, { firmId });
  return read.ok && read.value.visibility === 'assigned_or_admin';
}

export async function routeResearch(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!RESEARCH_PATHS.includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const scoped = contextForPrincipal(auth, authenticated.principal);
  if (!scoped.ok) return scoped.result;
  const context = scoped.context;
  const deps: RouteDeps = { auth, request, principal: authenticated.principal };

  if (request.path === '/research/settings') {
    // `{}` reads and any field updates, both admin-only: the ceilings are the
    // workspace's budget. A read of them is a command with an empty patch rather than
    // a separate path, because `updateResearchSettings` is where `decideAdminOnly`
    // lives and a read that skipped it would answer the budget to everybody.
    return await runRouteCommand(deps, researchSettingsCommandSchema, 'configure_research', async (scope, body) => {
      const { commandId: _commandId, clientVersion: _clientVersion, ...patch } = body;
      const updated = await updateResearchSettings(scope, patch);
      if (!updated.ok) return { ok: false, reason: updated.reason };
      const now = await databaseNow(scope);
      const businessTimeZone = await workspaceBusinessZone(scope);
      return {
        ok: true,
        value: {
          settings: updated.value,
          spend: await readSpend(scope, { businessTimeZone, at: now }),
          worstCaseRunCents: worstCaseRunCents({
            modelName: updated.value.modelName,
            maxPagesPerFirm: updated.value.maxPagesPerFirm,
            maxPageBytes: updated.value.maxPageBytes,
          }),
        },
      };
    });
  }

  if (request.path === '/research/firm/run') {
    return await runRouteCommand(deps, researchRunCommandSchema, 'run_research', async (scope, body) => {
      if (!(await visibleFirm(scope, body.firmId))) return { ok: false, reason: 'firm_unknown' };
      // Asked before the enqueue so a day at its ceiling answers the click rather
      // than queueing a job that will refuse in a minute's time. The handler asks
      // again, because the ceiling can be reached in between.
      const clearance = await researchClearanceAvailable(scope, { at: await databaseNow(scope) });
      if (!clearance.ok) {
        return { ok: false, reason: clearance.reason === 'research_disabled' ? 'research_disabled' : 'ceiling_reached' };
      }
      const actor = scope.scope.actor;
      const enqueued = await enqueueFirmResearch(scope, {
        firmId: body.firmId,
        trigger: 'user_request',
        ...(actor.kind === 'user' ? { requestedByUserId: actor.userId } : {}),
      });
      if (!enqueued.ok) return { ok: false, reason: enqueued.reason };
      return { ok: true, value: { revision: enqueued.value.revision, queued: enqueued.value.inserted } };
    });
  }

  if (request.path === '/research/firm/links/add') {
    return await runRouteCommand(deps, researchAddLinkCommandSchema, 'add_research_link', async (scope, body) => {
      if (!(await visibleFirm(scope, body.firmId))) return { ok: false, reason: 'firm_unknown' };
      const added = await addFirmLink(scope, { firmId: body.firmId, url: body.url });
      if (!added.ok) return { ok: false, reason: added.reason };
      const actor = scope.scope.actor;
      // The link is the point and the run is the consequence: a refusal to enqueue —
      // a ceiling, a run already open — leaves the link saved and answers `null`,
      // because losing the link would be the worse of the two failures.
      const enqueued = await enqueueFirmResearch(scope, {
        firmId: body.firmId,
        trigger: 'link_added',
        ...(actor.kind === 'user' ? { requestedByUserId: actor.userId } : {}),
      });
      return {
        ok: true,
        value: { link: added.value, revision: enqueued.ok ? enqueued.value.revision : null },
      };
    });
  }

  const parsed = researchFirmRequestSchema.safeParse(request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const firmId = parsed.data.firmId;
  if (!(await visibleFirm(context, firmId))) {
    return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }

  const now = await databaseNow(context);
  const businessTimeZone = await workspaceBusinessZone(context);
  const judgments = await readFirmJudgments(context, firmId);
  return {
    status: 200,
    body: {
      brief: await readCallBrief(context, firmId),
      facts: await listFirmFacts(context, firmId),
      judgments:
        judgments === null
          ? null
          : {
              fit: judgments.fit,
              problemEvidence: judgments.problemEvidence,
              timing: judgments.timing,
              reachability: judgments.reachability,
              reasons: judgments.reasons,
              callFirst: judgments.callFirst,
              likelyContactId: judgments.likelyContactId,
              judgedAt: judgments.judgedAt,
            },
      // Mapped rather than spread: `RunRow` also carries the generated `brief`, which
      // belongs to the call brief above and not to a list of what each run did.
      runs: (await listRuns(context, firmId, 5)).map(run => ({
        revision: run.revision,
        trigger: run.trigger,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        outcome: run.outcome,
        refusalCode: run.refusalCode,
        pagesFetched: run.pagesFetched,
        factsRecorded: run.factsRecorded,
        costCents: run.costCents,
        // Whether that figure is an invoice or the run's own reservation, and why the
        // model was or was not used. Both are the difference between "this run cost
        // nothing" and "nobody told us what this run cost".
        costEstimated: run.costEstimated,
        extraction: run.extraction,
      })),
      links: await listFirmLinks(context, firmId),
      spend: await readSpend(context, { businessTimeZone, at: now }),
    },
  };
}
