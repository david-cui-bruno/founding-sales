import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  SafeHandlerError,
  type ScheduledRunStatus,
} from "@callie-sourcing/shared";

import {
  loadMonthlyMetricHistory,
  publishMonthlyHealth,
  type CloudWatchSender,
} from "./cloudWatchMetrics";
import {
  MONTHLY_TARGETS,
  evaluateMonthlyHealth,
} from "./monthlyHealth";
import { logScheduledRunCompleted } from "./log";

export interface HandlerDeps {
  cloudwatch: CloudWatchSender;
  now?: () => Date;
}

export interface WatchdogResult {
  targetsEvaluated: number;
  unhealthyGaugeCount: number;
}

export async function runWatchdog(deps: HandlerDeps): Promise<WatchdogResult> {
  const now = deps.now?.() ?? new Date();
  const history = await loadMonthlyMetricHistory(deps.cloudwatch, now);
  const evaluations = MONTHLY_TARGETS.map((target) =>
    evaluateMonthlyHealth(target, history[target.component], now));
  await publishMonthlyHealth(deps.cloudwatch, evaluations, now);
  return {
    targetsEvaluated: evaluations.length,
    unhealthyGaugeCount: evaluations.reduce(
      (count, evaluation) => count + Number(evaluation.missingSuccess) + Number(evaluation.persistentUnprocessed),
      0,
    ),
  };
}

function defaultDeps(): HandlerDeps {
  return { cloudwatch: new CloudWatchClient({}) };
}

export function createHandler(
  depsFactory: () => HandlerDeps,
  monotonicNow: () => number = () => performance.now(),
): () => Promise<WatchdogResult> {
  let cachedDeps: HandlerDeps | null = null;
  return async () => {
    const startedAt = monotonicNow();
    let status: ScheduledRunStatus = "failure";
    let result: WatchdogResult | undefined;
    try {
      cachedDeps ??= depsFactory();
      result = await runWatchdog(cachedDeps);
      status = "success";
      return result;
    } catch {
      throw new SafeHandlerError();
    } finally {
      logScheduledRunCompleted(status === "success" ? "info" : "error", {
        status,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
        targetsEvaluated: result?.targetsEvaluated ?? 0,
        unhealthyGaugeCount: result?.unhealthyGaugeCount ?? 0,
      });
    }
  };
}

const productionHandler = createHandler(defaultDeps);

export async function handler(): Promise<WatchdogResult> {
  return productionHandler();
}
