import {
  GetMetricDataCommand,
  PutMetricDataCommand,
  type GetMetricDataCommandOutput,
} from "@aws-sdk/client-cloudwatch";
import { describe, expect, it } from "vitest";

import {
  loadMonthlyMetricHistory,
  publishMonthlyHealth,
  type CloudWatchSender,
} from "../src/cloudWatchMetrics";
import { MONTHLY_TARGETS, type MonthlyHealthEvaluation } from "../src/monthlyHealth";

const now = new Date("2026-09-10T18:00:00.000Z");
const queryIds = [
  "target0success",
  "target0unprocessed",
  "target1success",
  "target1unprocessed",
] as const;

function completePage(
  overrides: Partial<GetMetricDataCommandOutput> = {},
): GetMetricDataCommandOutput {
  return {
    $metadata: {},
    MetricDataResults: queryIds.map((Id, index) => ({
      Id,
      StatusCode: "Complete",
      Timestamps: [new Date(now.getTime() - (index + 1) * 60_000)],
      Values: [index],
    })),
    ...overrides,
  };
}

function senderFor(
  responses: readonly (GetMetricDataCommandOutput | Error)[],
): { sender: CloudWatchSender; commands: unknown[] } {
  const commands: unknown[] = [];
  let responseIndex = 0;
  const sender = {
    send: async (command: unknown) => {
      commands.push(command);
      const response = responses[responseIndex++];
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error("unexpected send");
      return response;
    },
  } as CloudWatchSender;
  return { sender, commands };
}

describe("loadMonthlyMetricHistory", () => {
  it("queries exactly four closed hourly metrics over 70 days", async () => {
    const { sender, commands } = senderFor([completePage()]);

    await loadMonthlyMetricHistory(sender, now);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetMetricDataCommand);
    const input = (commands[0] as GetMetricDataCommand).input;
    expect(input.StartTime).toEqual(new Date(now.getTime() - 70 * 24 * 60 * 60 * 1000));
    expect(input.EndTime).toEqual(now);
    expect(input.ScanBy).toBe("TimestampAscending");
    expect(input.MetricDataQueries).toHaveLength(4);
    expect(input.MetricDataQueries).toEqual([
      [0, "success", "ScheduledRunSuccess", "Sum"],
      [0, "unprocessed", "ScheduledRunUnprocessed", "Minimum"],
      [1, "success", "ScheduledRunSuccess", "Sum"],
      [1, "unprocessed", "ScheduledRunUnprocessed", "Minimum"],
    ].map(([targetIndex, suffix, metricName, stat]) => ({
      Id: `target${targetIndex}${suffix}`,
      ReturnData: true,
      MetricStat: {
        Metric: {
          Namespace: "Callie/Sourcing",
          MetricName: metricName,
          Dimensions: [{ Name: "Component", Value: MONTHLY_TARGETS[Number(targetIndex)]!.component }],
        },
        Period: 3600,
        Stat: stat,
      },
    })));
  });

  it("follows every token, merges pages, and sorts samples ascending", async () => {
    const later = new Date("2026-09-05T12:00:00.000Z");
    const earlier = new Date("2026-08-05T12:00:00.000Z");
    const first = completePage({
      NextToken: "page-2",
      MetricDataResults: queryIds.map((Id) => ({
        Id,
        StatusCode: "PartialData",
        Timestamps: [later],
        Values: [2],
      })),
    });
    const second = completePage({
      MetricDataResults: queryIds.map((Id) => ({
        Id,
        StatusCode: "Complete",
        Timestamps: [earlier],
        Values: [1],
      })),
    });
    const { sender, commands } = senderFor([first, second]);

    const history = await loadMonthlyMetricHistory(sender, now);

    expect(commands).toHaveLength(2);
    expect((commands[1] as GetMetricDataCommand).input.NextToken).toBe("page-2");
    for (const target of MONTHLY_TARGETS) {
      expect(history[target.component].success).toEqual([
        { timestamp: earlier, value: 1 },
        { timestamp: later, value: 2 },
      ]);
      expect(history[target.component].unprocessed).toEqual([
        { timestamp: earlier, value: 1 },
        { timestamp: later, value: 2 },
      ]);
    }
  });

  it.each([
    ["top-level messages", completePage({ Messages: [{ Code: "Private", Value: "raw provider message" }] })],
    ["unknown IDs", completePage({ MetricDataResults: [{ Id: "unknown", StatusCode: "Complete", Timestamps: [], Values: [] }] })],
    ["mismatched arrays", completePage({ MetricDataResults: [{ Id: queryIds[0], StatusCode: "Complete", Timestamps: [now], Values: [] }] })],
    ["invalid timestamps", completePage({ MetricDataResults: [{ Id: queryIds[0], StatusCode: "Complete", Timestamps: [new Date(Number.NaN)], Values: [1] }] })],
    ["non-finite values", completePage({ MetricDataResults: [{ Id: queryIds[0], StatusCode: "Complete", Timestamps: [now], Values: [Number.NaN] }] })],
    ["negative values", completePage({ MetricDataResults: [{ Id: queryIds[0], StatusCode: "Complete", Timestamps: [now], Values: [-1] }] })],
    ["invalid statuses", completePage({ MetricDataResults: [{ Id: queryIds[0], StatusCode: "InternalError", Timestamps: [], Values: [] }] })],
    ["terminal partial data", completePage({ MetricDataResults: queryIds.map((Id) => ({ Id, StatusCode: "PartialData", Timestamps: [], Values: [] })) })],
    ["incomplete expected IDs", completePage({ MetricDataResults: [{ Id: queryIds[0], StatusCode: "Complete", Timestamps: [], Values: [] }] })],
  ])("fails closed on %s", async (_case, response) => {
    const { sender } = senderFor([response]);
    await expect(loadMonthlyMetricHistory(sender, now)).rejects.toBeInstanceOf(Error);
  });

  it("requires every expected query to become complete after pagination", async () => {
    const partial = completePage({
      NextToken: "page-2",
      MetricDataResults: queryIds.map((Id) => ({ Id, StatusCode: "PartialData", Timestamps: [], Values: [] })),
    });
    const final = completePage({
      MetricDataResults: queryIds.slice(0, 3).map((Id) => ({ Id, StatusCode: "Complete", Timestamps: [], Values: [] })),
    });
    const { sender } = senderFor([partial, final]);
    await expect(loadMonthlyMetricHistory(sender, now)).rejects.toBeInstanceOf(Error);
  });

  it("propagates CloudWatch read failures internally", async () => {
    const failure = new Error("private read failure");
    const { sender } = senderFor([failure]);
    await expect(loadMonthlyMetricHistory(sender, now)).rejects.toBe(failure);
  });
});

describe("publishMonthlyHealth", () => {
  const evaluations: readonly MonthlyHealthEvaluation[] = MONTHLY_TARGETS.map((target, index) => ({
    component: target.component,
    olderDue: new Date("2026-08-01T00:00:00.000Z"),
    newerDue: new Date("2026-09-01T00:00:00.000Z"),
    missingSuccess: index === 0,
    persistentUnprocessed: index === 1,
  }));

  it("publishes all four closed 0/1 Count gauges in one call at the shared timestamp", async () => {
    const commands: unknown[] = [];
    const sender = { send: async (command: unknown) => { commands.push(command); return { $metadata: {} }; } } as CloudWatchSender;

    await publishMonthlyHealth(sender, evaluations, now);

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(PutMetricDataCommand);
    expect((commands[0] as PutMetricDataCommand).input).toEqual({
      Namespace: "Callie/Sourcing",
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
    });
  });

  it("propagates CloudWatch publish failures internally", async () => {
    const failure = new Error("private publish failure");
    const sender = { send: async () => { throw failure; } } as CloudWatchSender;
    await expect(publishMonthlyHealth(sender, evaluations, now)).rejects.toBe(failure);
  });
});
