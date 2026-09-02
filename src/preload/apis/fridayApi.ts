import {
  mutationReceiptSchema,
  type MutationReceipt,
} from '../../shared/contracts/commonContract';
import {
  cancelJobRequestSchema,
  createJobRequestSchema,
  fillJobRequestSchema,
  fridayReportRequestSchema,
  fridayReportSchema,
  metricDrilldownRequestSchema,
  metricDrilldownSchema,
  type CancelJobRequest,
  type CreateJobRequest,
  type FillJobRequest,
  type FridayReport,
  type FridayReportRequest,
  type MetricDrilldown,
  type MetricDrilldownRequest,
} from '../../shared/contracts/fridayContract';
import type { IpcClient } from '../ipcClient';

const FRIDAY_GET_CHANNEL = 'friday:get';
const FRIDAY_DRILLDOWN_CHANNEL = 'friday:drilldown';
const FRIDAY_CREATE_JOB_CHANNEL = 'friday:create-job';
const FRIDAY_FILL_JOB_CHANNEL = 'friday:fill-job';
const FRIDAY_CANCEL_JOB_CHANNEL = 'friday:cancel-job';

export type FridayApi = {
  getCurrent(input?: FridayReportRequest): Promise<FridayReport>;
  getDrilldown(input: MetricDrilldownRequest): Promise<MetricDrilldown>;
  createJob(input: CreateJobRequest): Promise<MutationReceipt>;
  fillJob(input: FillJobRequest): Promise<MutationReceipt>;
  cancelJob(input: CancelJobRequest): Promise<MutationReceipt>;
};

/**
 * Narrow preload API for the Friday scoreboard. Requests are validated before
 * invoke and responses after invoke; the renderer never computes metrics. An
 * omitted report request keeps the historical payload-free invoke for the
 * current week.
 */
export const createFridayApi = (client: IpcClient): FridayApi => ({
  getCurrent: (input) => input === undefined
    ? client.requestNoInput(FRIDAY_GET_CHANNEL, fridayReportSchema)
    : client.request(
      FRIDAY_GET_CHANNEL, fridayReportRequestSchema, fridayReportSchema, input,
    ),
  getDrilldown: (input) => client.request(
    FRIDAY_DRILLDOWN_CHANNEL, metricDrilldownRequestSchema, metricDrilldownSchema, input,
  ),
  createJob: (input) => client.request(
    FRIDAY_CREATE_JOB_CHANNEL, createJobRequestSchema, mutationReceiptSchema, input,
  ),
  fillJob: (input) => client.request(
    FRIDAY_FILL_JOB_CHANNEL, fillJobRequestSchema, mutationReceiptSchema, input,
  ),
  cancelJob: (input) => client.request(
    FRIDAY_CANCEL_JOB_CHANNEL, cancelJobRequestSchema, mutationReceiptSchema, input,
  ),
});
