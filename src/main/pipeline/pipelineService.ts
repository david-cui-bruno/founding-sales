import type { PipelineSnapshot } from '../../shared/contracts/pipelineContract';

/**
 * Narrow query surface the pipeline IPC registrar depends on. The final
 * composition owner injects a delegate backed by the encrypted domain.
 */
export type PipelineProvider = {
  get(): Promise<PipelineSnapshot>;
};

/**
 * The projection query exposed by the encrypted founder-sales domain.
 * Stage ordering, card shaping, and won/closed metadata all live there.
 */
export type PipelineProjectionSource = {
  getPipelineProjection(): PipelineSnapshot | Promise<PipelineSnapshot>;
};
