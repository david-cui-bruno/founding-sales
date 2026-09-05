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

async function runWatchdogWithProgress(
  deps: HandlerDeps,
  onEvaluated: (result: WatchdogResult) => void,
): Promise<WatchdogResult> {
  const now = deps.now?.() ?? new Date();
  const history = await loadMonthlyMetricHistory(deps.cloudwatch, now);
  const evaluations: ReturnType<typeof evaluateMonthlyHealth>[] = [];
  const result: WatchdogResult = {
    targetsEvaluated: 0,
    unhealthyGaugeCount: 0,
  };
  for (const target of MONTHLY_TARGETS) {
    const evaluation = evaluateMonthlyHealth(target, history[target.component], now);
    evaluations.push(evaluation);
    result.targetsEvaluated += 1;
    result.unhealthyGaugeCount += Number(evaluation.missingSuccess)
      + Number(evaluation.persistentUnprocessed);
    onEvaluated({ ...result });
  }
  await publishMonthlyHealth(deps.cloudwatch, evaluations, now);
  return result;
}

export async function runWatchdog(deps: HandlerDeps): Promise<WatchdogResult> {
  return runWatchdogWithProgress(deps, () => {});
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
    let progress: WatchdogResult | undefined;
    try {
      cachedDeps ??= depsFactory();
      const result = await runWatchdogWithProgress(cachedDeps, (evaluated) => {
        progress = evaluated;
      });
      status = "success";
      return result;
    } catch {
      throw new SafeHandlerError();
    } finally {
      logScheduledRunCompleted(status === "success" ? "info" : "error", {
        status,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
        targetsEvaluated: progress?.targetsEvaluated ?? 0,
        unhealthyGaugeCount: progress?.unhealthyGaugeCount ?? 0,
      });
    }
  };
}

const productionHandler = createHandler(defaultDeps);

export async function handler(): Promise<WatchdogResult> {
  return productionHandler();
}
