import { z } from 'zod';
import type { RepositoryContext } from '@fss/domain/db';
import {
  activeRoutePolicy,
  enqueueDiscoveryPage,
  enqueueFirmEnrichment,
  isAtLeastAsStrict,
  listProviders,
  listSuggestions,
  publishRoutePolicy,
  readBusinessTimeZone,
  readProviderLedger,
  readResearchSettings,
  reviewSuggestion,
  routePolicyHistory,
  updateProvider,
  updateResearchSettings,
  type ResearchResult,
} from '@fss/domain/research';
import { runCommand } from '../auth/index.ts';
import type { AuthDeps, AuthenticatedPrincipal } from '../auth/index.ts';
import { REFUSAL_STATUS, contextForPrincipal, crmReply, redactError, requirePrincipal } from './crmSupport.ts';
import type { ApiRequest, RouteResult, RoutingOptions } from './types.ts';

/**
 * The research surface (specification 7.4, 10.1, 14.1; deliverable 2 and 3).
 *
 * Reads:
 *
 * * `GET /research/config` — settings, approved providers, the policy in force and
 *   today's provider ledger. Admin-only: a provider's reviewed per-call price and the
 *   day's spend are commercial configuration, not firm data.
 * * `GET /research/policy` — the published threshold history.
 * * `GET /research/suggestions` — what a person has to review. A salesperson sees
 *   their assigned firms' suggestions; an admin sees every one, and the filter is in
 *   the statement rather than applied to the page afterwards.
 *
 * Commands, every one through `runCommand` so the receipt, the payload hash, the
 * device and the mutation commit together (5.3):
 *
 * * `POST /research/config` — research limits.
 * * `POST /research/providers` — enable, price or cap one approved provider.
 * * `POST /research/policy` — publish a new route-eligibility version. Insert-only.
 * * `POST /research/suggestions/review` — accept or reject.
 * * `POST /research/discover` — enqueue one discovery page.
 * * `POST /research/enrich` — enqueue one firm enrichment.
 *
 * ## The two enqueue commands do not research anything
 *
 * They write a `jobs` row and return. No provider is called inside an HTTP request:
 * section 13.2 owns the work, the ceiling is checked before the row is written so a
 * spent day produces no queued work, and the worker asks the ceiling again when it
 * claims. A request that called a provider would also mean an admin's browser tab
 * holding a transaction open across somebody else's network.
 *
 * `enqueue*` takes a `Queryable` as well as the context, because `enqueueJob` is one
 * of G5's operational functions and names `workspace_id` itself rather than taking a
 * scope (docs/decisions/g5-queue-scope.md). Passing `repository.db` is what makes the
 * job row and the receipt commit together, because inside `runCommand` that is the
 * connection the transaction is open on — Appendix A's "Import batch" row applied to a
 * research sweep.
 */

const commandEnvelope = {
  commandId: z.string().min(1).max(128),
  clientVersion: z.string().min(1).max(40),
};

const settingsCommandSchema = z.strictObject({
  ...commandEnvelope,
  enabled: z.boolean().optional(),
  dailyPageCeiling: z.number().int().min(0).max(10_000).optional(),
  dailyFirmCeiling: z.number().int().min(0).max(100_000).optional(),
  dailyCostCeilingMicros: z.number().int().min(0).optional(),
  maxPagesPerFirm: z.number().int().min(1).max(10).optional(),
  maxPageBytes: z.number().int().min(1024).max(1_000_000).optional(),
});

const providerCommandSchema = z.strictObject({
  ...commandEnvelope,
  providerKey: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/u),
  enabled: z.boolean().optional(),
  costPerCallMicros: z.number().int().min(0).optional(),
  dailyCallCeiling: z.number().int().min(0).max(100_000).optional(),
  termsAllowRetention: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
});

const policyCommandSchema = z.strictObject({
  ...commandEnvelope,
  version: z.string().regex(/^[a-z0-9._-]{1,40}$/u),
  minimumAssociationConfidence: z.number().min(0).max(1),
  requireTechnicalValidation: z.boolean().optional(),
  trustedSources: z.array(z.enum(['research_provider', 'salesperson', 'import', 'website', 'reply'])).optional(),
  note: z.string().trim().min(1).max(500).optional(),
  effectiveFrom: z.string().datetime().optional(),
});

const reviewCommandSchema = z.strictObject({
  ...commandEnvelope,
  suggestionId: z.string().uuid(),
  decision: z.enum(['accepted', 'rejected']),
  note: z.string().trim().min(1).max(500).optional(),
});

const discoverCommandSchema = z.strictObject({
  ...commandEnvelope,
  query: z.string().trim().min(1).max(500),
  pageToken: z.string().min(1).max(4096).nullable().optional(),
  providerKey: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/u),
});

const enrichCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: z.string().uuid(),
  providerKey: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/u),
  extractionProviderKey: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/u).nullable().optional(),
});

export const RESEARCH_PATHS = [
  '/research/config',
  '/research/providers',
  '/research/policy',
  '/research/suggestions',
  '/research/suggestions/review',
  '/research/discover',
  '/research/enrich',
] as const;

/**
 * Parse, run and reply, for a research command.
 *
 * The same three lines of work `runCrmCommand` does, with one difference that matters:
 * the research refusal codes are their own closed set, so this cannot borrow
 * `runCrmCommand`, whose `CrmResult` is typed on the CRM's codes. The reply shape is
 * identical — `crmReply` takes the reason as a string — so a client switches on the
 * code the same way whichever surface answered.
 */
async function runResearchCommand<Schema extends z.ZodType<{ commandId: string; clientVersion: string }>, T>(
  deps: { readonly auth: AuthDeps; readonly request: ApiRequest; readonly principal: AuthenticatedPrincipal },
  schema: Schema,
  kind: string,
  work: (context: RepositoryContext, body: z.infer<Schema>) => Promise<ResearchResult<T>>,
): Promise<RouteResult> {
  const parsed = schema.safeParse(deps.request.body);
  if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
  const body = parsed.data;
  const { commandId, clientVersion, ...payload } = body as { commandId: string; clientVersion: string };

  const outcome = await runCommand(
    deps.auth,
    deps.principal,
    { commandId, kind, payload, clientVersion },
    async context => {
      const result = await work(context, body);
      if (result.ok) return { status: 'accepted', result: result.value };
      return { status: 'refused', reason: result.reason };
    },
  );
  return crmReply(outcome);
}

export async function routeResearch(request: ApiRequest, options: RoutingOptions): Promise<RouteResult | null> {
  if (!(RESEARCH_PATHS as readonly string[]).includes(request.path)) return null;
  const auth = options.auth;
  if (auth === undefined) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };

  const authenticated = await requirePrincipal(auth, request);
  if (!authenticated.ok) return authenticated.result;
  const principal = authenticated.principal;
  const scoped = contextForPrincipal(auth, principal);
  if (!scoped.ok) return scoped.result;
  const context = scoped.context;
  const deps = { auth, request, principal };

  if (request.method === 'GET' || request.method === 'HEAD') {
    return await read(request, context, principal);
  }
  if (request.method !== 'POST') {
    return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
  }

  switch (request.path) {
    case '/research/config':
      return await runResearchCommand(deps, settingsCommandSchema, 'research.settings_updated', async (repository, body) =>
        await updateResearchSettings(repository, {
          enabled: body.enabled,
          dailyPageCeiling: body.dailyPageCeiling,
          dailyFirmCeiling: body.dailyFirmCeiling,
          dailyCostCeilingMicros: body.dailyCostCeilingMicros,
          maxPagesPerFirm: body.maxPagesPerFirm,
          maxPageBytes: body.maxPageBytes,
        }),
      );

    case '/research/providers':
      return await runResearchCommand(deps, providerCommandSchema, 'research.provider_updated', async (repository, body) =>
        await updateProvider(repository, {
          providerKey: body.providerKey,
          patch: {
            enabled: body.enabled,
            costPerCallMicros: body.costPerCallMicros,
            dailyCallCeiling: body.dailyCallCeiling,
            termsAllowRetention: body.termsAllowRetention,
            retentionDays: body.retentionDays,
          },
        }),
      );

    case '/research/policy':
      return await runResearchCommand(deps, policyCommandSchema, 'research.route_policy_published', async (repository, body) => {
        // What the change would do is reported, never used to refuse it: an admin may
        // deliberately relax a threshold, and the history records that they did.
        const current = await activeRoutePolicy(repository);
        const published = await publishRoutePolicy(repository, {
          version: body.version,
          minimumAssociationConfidence: body.minimumAssociationConfidence,
          requireTechnicalValidation: body.requireTechnicalValidation,
          trustedSources: body.trustedSources,
          note: body.note,
          effectiveFrom: body.effectiveFrom === undefined ? undefined : new Date(body.effectiveFrom),
        });
        if (!published.ok) return published;
        return {
          ok: true,
          value: {
            version: published.value.version,
            effectiveFrom: published.value.effectiveFrom,
            relaxesThePrevious: current === null ? false : !isAtLeastAsStrict(published.value, current),
          },
        };
      });

    case '/research/suggestions/review':
      return await runResearchCommand(deps, reviewCommandSchema, 'research.suggestion_reviewed', async (repository, body) =>
        await reviewSuggestion(repository, {
          suggestionId: body.suggestionId,
          decision: body.decision,
          note: body.note,
        }),
      );

    case '/research/discover':
      return await runResearchCommand(deps, discoverCommandSchema, 'research.page_enqueued', async (repository, body) =>
        await enqueueDiscoveryPage(repository, repository.db, {
          query: body.query,
          pageToken: body.pageToken,
          providerKey: body.providerKey,
          at: new Date().toISOString(),
        }),
      );

    case '/research/enrich':
      return await runResearchCommand(deps, enrichCommandSchema, 'research.firm_enqueued', async (repository, body) =>
        await enqueueFirmEnrichment(repository, repository.db, {
          firmId: body.firmId,
          providerKey: body.providerKey,
          extractionProviderKey: body.extractionProviderKey,
          at: new Date().toISOString(),
        }),
      );

    default:
      return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
  }
}

const suggestionQuerySchema = z.strictObject({
  firmId: z.string().uuid().optional(),
  state: z.enum(['proposed', 'applied', 'accepted', 'rejected', 'superseded']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

async function read(
  request: ApiRequest,
  context: RepositoryContext,
  principal: AuthenticatedPrincipal,
): Promise<RouteResult> {
  const isAdmin = principal.role === 'admin';

  if (request.path === '/research/config') {
    // Admin-only, and refused with `unauthenticated`'s redacted sentence rather than a
    // message that tells a salesperson which endpoints exist.
    if (!isAdmin) return { status: 403, body: redactError('unauthenticated') };
    const at = new Date().toISOString();
    const settings = await readResearchSettings(context);
    if (settings === null) return { status: REFUSAL_STATUS.not_found, body: redactError('not_found') };
    const businessTimeZone = await readBusinessTimeZone(context);
    return {
      status: 200,
      body: {
        settings,
        businessTimeZone,
        providers: await listProviders(context),
        activePolicy: await activeRoutePolicy(context),
        ledger: await readProviderLedger(context, { businessTimeZone, at }),
      },
    };
  }

  if (request.path === '/research/policy') {
    if (!isAdmin) return { status: 403, body: redactError('unauthenticated') };
    return {
      status: 200,
      body: { active: await activeRoutePolicy(context), history: await routePolicyHistory(context) },
    };
  }

  if (request.path === '/research/suggestions') {
    const parsed = suggestionQuerySchema.safeParse(Object.fromEntries(request.query.entries()));
    if (!parsed.success) return { status: REFUSAL_STATUS.malformed_body, body: redactError('malformed_body') };
    return {
      status: 200,
      body: {
        suggestions: await listSuggestions(context, {
          firmId: parsed.data.firmId,
          state: parsed.data.state,
          limit: parsed.data.limit,
        }),
      },
    };
  }

  // A command path asked for with GET.
  return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
}
