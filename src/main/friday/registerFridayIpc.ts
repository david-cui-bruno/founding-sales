import {
  mutationReceiptSchema,
  type MutationReceipt,
} from '../../shared/contracts/commonContract';
import {
  cancelJobRequestSchema,
  createJobRequestSchema,
  fillJobRequestSchema,
  fridayReportSchema,
  metricDrilldownRequestSchema,
  metricDrilldownSchema,
  type CancelJobRequest,
  type CreateJobRequest,
  type FillJobRequest,
  type FridayReport,
  type MetricDrilldown,
  type MetricDrilldownRequest,
} from '../../shared/contracts/fridayContract';
import { registerValidatedIpc } from '../ipc/registerValidatedIpc';
import type { FridayProvider } from './fridayService';

export const FRIDAY_GET_CHANNEL = 'friday:get';
export const FRIDAY_DRILLDOWN_CHANNEL = 'friday:drilldown';
export const FRIDAY_CREATE_JOB_CHANNEL = 'friday:create-job';
export const FRIDAY_FILL_JOB_CHANNEL = 'friday:fill-job';
export const FRIDAY_CANCEL_JOB_CHANNEL = 'friday:cancel-job';

/**
 * Registers exactly the five Friday channels. `friday:get` takes no request
 * payload; every response is re-validated against the strict contract before
 * it crosses the IPC boundary.
 */
export function registerFridayIpc(
  provider: FridayProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisters = [
    registerValidatedIpc<undefined, FridayReport>({
      channel: FRIDAY_GET_CHANNEL,
      requestSchema: null,
      responseSchema: fridayReportSchema,
      handler: () => provider.getCurrent(),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<MetricDrilldownRequest, MetricDrilldown>({
      channel: FRIDAY_DRILLDOWN_CHANNEL,
      requestSchema: metricDrilldownRequestSchema,
      responseSchema: metricDrilldownSchema,
      handler: (input) => provider.getDrilldown(input),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<CreateJobRequest, MutationReceipt>({
      channel: FRIDAY_CREATE_JOB_CHANNEL,
      requestSchema: createJobRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (input) => provider.createJob(input),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<FillJobRequest, MutationReceipt>({
      channel: FRIDAY_FILL_JOB_CHANNEL,
      requestSchema: fillJobRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (input) => provider.fillJob(input),
      isTrustedRendererUrl,
    }),
    registerValidatedIpc<CancelJobRequest, MutationReceipt>({
      channel: FRIDAY_CANCEL_JOB_CHANNEL,
      requestSchema: cancelJobRequestSchema,
      responseSchema: mutationReceiptSchema,
      handler: (input) => provider.cancelJob(input),
      isTrustedRendererUrl,
    }),
  ];

  return () => {
    for (const unregister of unregisters) {
      unregister();
    }
  };
}
