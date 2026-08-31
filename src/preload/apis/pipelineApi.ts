import {
  pipelineSnapshotSchema,
  type PipelineSnapshot,
} from '../../shared/contracts/pipelineContract';
import type { IpcClient } from '../ipcClient';

const PIPELINE_GET_CHANNEL = 'pipeline:get';

export type PipelineApi = {
  get(): Promise<PipelineSnapshot>;
};

/** Read-only preload API: the pipeline exposes no mutation commands. */
export const createPipelineApi = (client: IpcClient): PipelineApi => ({
  get: () => client.requestNoInput(PIPELINE_GET_CHANNEL, pipelineSnapshotSchema),
});
