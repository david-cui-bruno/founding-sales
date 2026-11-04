import type {ClassifyWorkerOptions} from '../handlers/classify.ts';
import type {ResearchWorkerOptions} from '../handlers/research.ts';
import {anthropicExtraction} from '../research/anthropicExtraction.ts';
import {researchPageFetch} from '../research/companyPageFetch.ts';

/**
 * Lane R's two ports (`docs/greenfield/research.md`).
 *
 * The page fetch is always present: it needs no credential, and a run with nothing
 * else still records the firm's own pages as evidence. The extraction is present only
 * when the classifier transport is — the **same** transport, from the same
 * `classifyWorkerOptions` call, so the key is read once per process and this file
 * never sees a value.
 *
 * The model is `DEFAULT_RESEARCH_SETTINGS.modelName` rather than a per-workspace read,
 * because `research_settings_model_known` admits exactly one model in v1 and
 * `pricing.ts` has exactly one price row. The day a second model is added, this
 * becomes a per-run construction and the CHECK, the price table and this line move
 * together.
 */
export function composeResearch(classifier: ClassifyWorkerOptions | undefined): ResearchWorkerOptions {
  const pageFetch = researchPageFetch();
  if (classifier === undefined) return { pageFetch };
  return {
    pageFetch,
    // No model here: the model and the output bound travel with each request, from the
    // `provider_reservations` row that priced it. A model fixed at composition was a
    // second answer to "what is this call?" that the money did not know about.
    extraction: anthropicExtraction({ transport: classifier.transport }),
  };
}

/** The startup line. Says whether the extraction port is configured, never with what. */
export function describeResearch(options: ResearchWorkerOptions | undefined): {
  readonly research_extraction_configured: boolean;
} {
  return { research_extraction_configured: options?.extraction !== undefined };
}
