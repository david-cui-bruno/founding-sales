import {
  GetMetricDataCommand,
  PutMetricDataCommand,
  type CloudWatchClient,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";

import {
  MONTHLY_TARGETS,
  type MetricSample,
  type MonthlyHealthEvaluation,
  type MonthlyTargetSamples,
} from "./monthlyHealth";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 70;
const NAMESPACE = "Callie/Sourcing";

export type MonthlyMetricHistory = Readonly<Record<
  (typeof MONTHLY_TARGETS)[number]["component"],
  MonthlyTargetSamples
>>;

export type CloudWatchSender = Pick<CloudWatchClient, "send">;

const queryDefinitions = MONTHLY_TARGETS.flatMap((target, targetIndex) => [
  {
    id: `target${targetIndex}success`,
    component: target.component,
    sampleKind: "success" as const,
    metricName: "ScheduledRunSuccess",
    stat: "Sum",
  },
  {
    id: `target${targetIndex}unprocessed`,
    component: target.component,
    sampleKind: "unprocessed" as const,
    metricName: "ScheduledRunUnprocessed",
    stat: "Minimum",
  },
]);

const definitionsById = new Map(queryDefinitions.map((definition) => [definition.id, definition]));

function metricDataQueries(): MetricDataQuery[] {
  return queryDefinitions.map((definition) => ({
    Id: definition.id,
    ReturnData: true,
    MetricStat: {
      Metric: {
        Namespace: NAMESPACE,
        MetricName: definition.metricName,
        Dimensions: [{ Name: "Component", Value: definition.component }],
      },
      Period: 3600,
      Stat: definition.stat,
    },
  }));
}

function assertValidNow(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("invalid evaluation time");
  }
}

function appendSamples(
  destination: MetricSample[],
  timestamps: readonly Date[] | undefined,
  values: readonly number[] | undefined,
): void {
  const safeTimestamps = timestamps ?? [];
  const safeValues = values ?? [];
  if (safeTimestamps.length !== safeValues.length) {
    throw new Error("invalid metric result shape");
  }
  for (let index = 0; index < safeTimestamps.length; index += 1) {
    const timestamp = safeTimestamps[index];
    const value = safeValues[index];
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      throw new Error("invalid metric timestamp");
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("invalid metric value");
    }
    destination.push({ timestamp, value });
  }
}

export async function loadMonthlyMetricHistory(
  cloudwatch: CloudWatchSender,
  now: Date,
): Promise<MonthlyMetricHistory> {
  assertValidNow(now);
  const collected = new Map(queryDefinitions.map(({ id }) => [id, [] as MetricSample[]]));
  const completed = new Set<string>();
  let nextToken: string | undefined;

  do {
    const response = await cloudwatch.send(new GetMetricDataCommand({
      MetricDataQueries: metricDataQueries(),
      StartTime: new Date(now.getTime() - HISTORY_DAYS * DAY_MS),
      EndTime: now,
      ScanBy: "TimestampAscending",
      ...(nextToken === undefined ? {} : { NextToken: nextToken }),
    }));

    if ((response.Messages?.length ?? 0) > 0) {
      throw new Error("CloudWatch response messages are not accepted");
    }
    const responseNextToken = response.NextToken;
    for (const result of response.MetricDataResults ?? []) {
      const id = result.Id;
      if (id === undefined || !definitionsById.has(id)) {
        throw new Error("unexpected metric query ID");
      }
      if (result.StatusCode !== "Complete" && result.StatusCode !== "PartialData") {
        throw new Error("invalid metric result status");
      }
      if (result.StatusCode === "PartialData" && responseNextToken === undefined) {
        throw new Error("terminal partial metric data");
      }
      appendSamples(collected.get(id)!, result.Timestamps, result.Values);
      if (result.StatusCode === "Complete") completed.add(id);
    }
    nextToken = responseNextToken;
  } while (nextToken !== undefined);

  if (completed.size !== queryDefinitions.length) {
    throw new Error("incomplete metric history");
  }

  for (const samples of collected.values()) {
    samples.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  }

  const history = Object.fromEntries(MONTHLY_TARGETS.map((target) => [
    target.component,
    { success: [] as MetricSample[], unprocessed: [] as MetricSample[] },
  ])) as Record<(typeof MONTHLY_TARGETS)[number]["component"], { success: MetricSample[]; unprocessed: MetricSample[] }>;

  for (const definition of queryDefinitions) {
    history[definition.component][definition.sampleKind] = collected.get(definition.id)!;
  }
  return history;
}

export async function publishMonthlyHealth(
  cloudwatch: CloudWatchSender,
  evaluations: readonly MonthlyHealthEvaluation[],
  now: Date,
): Promise<void> {
  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: evaluations.flatMap((evaluation) => [
      {
        MetricName: "MonthlyMissingSuccess",
        Dimensions: [{ Name: "Component", Value: evaluation.component }],
        Timestamp: now,
        Unit: "Count",
        Value: evaluation.missingSuccess ? 1 : 0,
      },
      {
        MetricName: "MonthlyPersistentUnprocessed",
        Dimensions: [{ Name: "Component", Value: evaluation.component }],
        Timestamp: now,
        Unit: "Count",
        Value: evaluation.persistentUnprocessed ? 1 : 0,
      },
    ]),
  }));
}
