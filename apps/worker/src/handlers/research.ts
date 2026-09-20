import { repositoryContext } from '@fss/domain/db';
import type { JobHandler, JobHandlerInput } from '@fss/domain/jobs';
import {
  parseDiscoveryPagePayload,
  parseEnrichmentPayload,
  runDiscoveryPage,
  runFirmEnrichment,
  type DiscoveryProvider,
  type ExtractionProvider,
  type PageFetchProvider,
  type ResearchProviders,
} from '@fss/domain/research';

/**
 * The two research handlers (specification 7.4, 13.2, Appendix C).
 *
 * Appendix C gives both kinds `business_uniqueness`, and migration 0005 is what makes
 * that true: `research_pages` is unique on `(workspace, query_hash, page_hash)` and
 * `research_firm_runs` on `(workspace, firm, revision)`. So the runner commits each
 * handler together with its completion, a worker whose lease was stolen rolls its work
 * back with the failed completion, and the unique constraint is the backstop for two
 * workers that somehow committed against different rows.
 * `apps/worker/test/researchHandlers.test.ts` runs the real stolen-lease harness over
 * both and counts one business effect.
 *
 * ## Providers are injected, and there are none in this repository
 *
 * `researchHandlers` takes a `ResearchProviders` object. In every test that object is
 * the recorded fixtures from `@fss/domain/research/testing`; in production it will be
 * the live adapters, which are a separate reviewed change. A handler given no provider
 * for its kind refuses the job as a configuration failure rather than running with a
 * substitute, because the substitute a research handler would reach for is a network
 * call nobody approved.
 *
 * ## A refusal is not a failure
 *
 * A ceiling, a disabled provider, a suppressed firm and a firm with no website are all
 * ordinary outcomes: the run records them and the job **completes**. Making them throw
 * would burn four attempts and then produce a dead job and a critical alert about a
 * research sweep that was working exactly as configured.
 *
 * A *provider* refusal does throw, so the job retries under G5's backoff ladder and
 * eventually becomes a dead job an admin can requeue — which is the right shape for
 * "the provider was briefly unavailable" and for "the credential is wrong" alike.
 */

/** The refusals that are a configured outcome rather than something to retry. */
const TERMINAL_REFUSALS = new Set([
  'research_disabled',
  'provider_disabled',
  'provider_unknown',
  'provider_ceiling_reached',
  'daily_ceiling_reached',
  'cost_ceiling_reached',
  'firm_suppressed',
  'firm_unknown',
  'firm_merged',
  'source_blocked',
  'no_candidates',
  'invalid_input',
]);

export class ResearchHandlerError extends Error {
  constructor(
    readonly code: 'PAYLOAD_INVALID' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REFUSED',
    message: string,
  ) {
    super(message);
    this.name = 'ResearchHandlerError';
  }
}

export interface ResearchHandlerOptions {
  readonly providers: ResearchProviders;
  readonly maxAttempts?: number | undefined;
  readonly leaseSeconds?: number | undefined;
  /** Database time for the run. Defaults to the process clock at claim time. */
  readonly now?: (() => Date) | undefined;
}

function discoveryProviderFor(
  providers: ResearchProviders,
  providerKey: string,
): DiscoveryProvider {
  const provider = providers.discovery;
  if (provider === undefined) {
    throw new ResearchHandlerError('PROVIDER_UNAVAILABLE', 'this worker has no discovery provider');
  }
  if (provider.providerKey !== providerKey) {
    // The payload names the provider the job was materialized for. A worker holding a
    // different one must not silently substitute it: the ledger, the cost and the
    // approved terms all belong to the provider that was asked for.
    throw new ResearchHandlerError(
      'PROVIDER_UNAVAILABLE',
      `the job asks for ${providerKey} and this worker has ${provider.providerKey}`,
    );
  }
  return provider;
}

function pageFetchProviderFor(providers: ResearchProviders, providerKey: string): PageFetchProvider {
  const provider = providers.pageFetch;
  if (provider === undefined) {
    throw new ResearchHandlerError('PROVIDER_UNAVAILABLE', 'this worker has no page-fetch provider');
  }
  if (provider.providerKey !== providerKey) {
    throw new ResearchHandlerError(
      'PROVIDER_UNAVAILABLE',
      `the job asks for ${providerKey} and this worker has ${provider.providerKey}`,
    );
  }
  return provider;
}

function extractionProviderFor(
  providers: ResearchProviders,
  providerKey: string | null,
): ExtractionProvider | undefined {
  if (providerKey === null) return undefined;
  const provider = providers.extraction;
  if (provider === undefined || provider.providerKey !== providerKey) {
    // Absent extraction is a smaller result, not a failure: the run records the pages
    // and the deterministic findings. So this returns undefined rather than throwing.
    return undefined;
  }
  return provider;
}

/** `research.page`: one discovery page for one query. */
export function researchPageHandler(options: ResearchHandlerOptions): JobHandler {
  const clock = options.now ?? ((): Date => new Date());
  return {
    kind: 'research.page',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 120,
    handle: async (input: JobHandlerInput): Promise<void> => {
      const payload = parseDiscoveryPagePayload(input.job.payload);
      if (payload === null) {
        throw new ResearchHandlerError('PAYLOAD_INVALID', 'a research.page payload names a query and a provider');
      }
      const provider = discoveryProviderFor(options.providers, payload.providerKey);
      const context = repositoryContext(input.scope, input.session);
      const outcome = await runDiscoveryPage(context, {
        provider,
        query: payload.query,
        pageToken: payload.pageToken,
        requestedByUserId: payload.requestedByUserId,
        at: clock().toISOString(),
      });
      if (!outcome.ok && !TERMINAL_REFUSALS.has(outcome.reason)) {
        throw new ResearchHandlerError('PROVIDER_REFUSED', `the discovery provider refused: ${outcome.reason}`);
      }
    },
  };
}

/** `research.firm`: one enrichment of one firm at one revision. */
export function researchFirmHandler(options: ResearchHandlerOptions): JobHandler {
  const clock = options.now ?? ((): Date => new Date());
  return {
    kind: 'research.firm',
    protection: 'business_uniqueness',
    maxAttempts: options.maxAttempts ?? 4,
    leaseSeconds: options.leaseSeconds ?? 120,
    handle: async (input: JobHandlerInput): Promise<void> => {
      const payload = parseEnrichmentPayload(input.job.payload);
      if (payload === null) {
        throw new ResearchHandlerError('PAYLOAD_INVALID', 'a research.firm payload names a firm and a revision');
      }
      const pageFetch = pageFetchProviderFor(options.providers, payload.providerKey);
      const extraction = extractionProviderFor(options.providers, payload.extractionProviderKey);
      const context = repositoryContext(input.scope, input.session);
      const outcome = await runFirmEnrichment(context, {
        firmId: payload.firmId,
        revision: payload.revision,
        pageFetch,
        ...(extraction === undefined ? {} : { extraction }),
        at: clock().toISOString(),
      });
      if (!outcome.ok && !TERMINAL_REFUSALS.has(outcome.reason)) {
        throw new ResearchHandlerError('PROVIDER_REFUSED', `the enrichment refused: ${outcome.reason}`);
      }
    },
  };
}

/**
 * Both handlers. A worker with no providers configured registers neither, so a
 * deployment that has not been given its provider adapters leaves `research.page` and
 * `research.firm` unclaimed in the queue rather than failing them four times each.
 */
export function researchHandlers(options: ResearchHandlerOptions): readonly JobHandler[] {
  const handlers: JobHandler[] = [];
  if (options.providers.discovery !== undefined) handlers.push(researchPageHandler(options));
  if (options.providers.pageFetch !== undefined) handlers.push(researchFirmHandler(options));
  return handlers;
}
