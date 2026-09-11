import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  FridayReport,
  FridayReportRequest,
  MetricDrilldown,
  MetricDrilldownRequest,
} from '../../shared/contracts/fridayContract';

/**
 * Narrow surface the Friday IPC registrar depends on. The final composition
 * owner injects a delegate backed by the encrypted domain.
 */
export type FridayProvider = {
  getCurrent(input?: FridayReportRequest): Promise<FridayReport>;
  getDrilldown(input: MetricDrilldownRequest): Promise<MetricDrilldown>;
  createJob(input: CreateJobRequest): Promise<MutationReceipt>;
  fillJob(input: FillJobRequest): Promise<MutationReceipt>;
  cancelJob(input: CancelJobRequest): Promise<MutationReceipt>;
};

/**
 * The scoreboard queries and founder job commands exposed by the encrypted
 * founder-sales domain. Week bounds, funnel counting, rate math, job status
 * derivation, and the fill denominator all live there. An omitted report
 * request means the current week (weekOffset 0).
 */
export type FridayReportSource = {
  getFridayReport(input?: FridayReportRequest): FridayReport | Promise<FridayReport>;
  getMetricDrilldown(
    input: MetricDrilldownRequest,
  ): MetricDrilldown | Promise<MetricDrilldown>;
  createJobRequest(input: CreateJobRequest): MutationReceipt | Promise<MutationReceipt>;
  markJobFilled(input: FillJobRequest): MutationReceipt | Promise<MutationReceipt>;
  cancelJobRequest(input: CancelJobRequest): MutationReceipt | Promise<MutationReceipt>;
};
