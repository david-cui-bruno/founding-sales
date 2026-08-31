import {
  pipelineSnapshotSchema,
  type PipelineSnapshot,
} from '../../shared/contracts/pipelineContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { PipelineProvider } from './pipelineService';

export const PIPELINE_GET_CHANNEL = 'pipeline:get';

/**
 * Registers only `pipeline:get`. The channel takes no request payload and
 * returns the strict, fully validated pipeline snapshot.
 */
export function registerPipelineIpc(
  provider: PipelineProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  return registerValidatedIpc<undefined, PipelineSnapshot>({
    channel: PIPELINE_GET_CHANNEL,
    requestSchema: null,
    responseSchema: pipelineSnapshotSchema,
    handler: () => provider.get(),
    isTrustedRendererUrl,
  });
}
