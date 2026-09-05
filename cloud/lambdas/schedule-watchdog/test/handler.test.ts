import { GetMetricDataCommand, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { describe, expect, it, vi } from "vitest";

import { type CloudWatchSender } from "../src/cloudWatchMetrics";
import { createHandler, runWatchdog } from "../src/handler";

const now = new Date("2026-09-10T18:00:00.000Z");
const ids = ["target0success", "target0unprocessed", "target1success", "target1unprocessed"];

function successfulSender(
  values: readonly [number, number, number, number] = [1, 0, 1, 0],
): { cloudwatch: CloudWatchSender; commands: unknown[] } {
  const commands: unknown[] = [];
  const timestamps = [
    new Date("2026-08-15T12:00:00.000Z"),
    new Date("2026-08-15T12:00:00.000Z"),
    new Date("2026-08-15T12:00:00.000Z"),
    new Date("2026-08-15T12:00:00.000Z"),
  ];
  const cloudwatch = {
    send: async (command: unknown) => {
      commands.push(command);
      if (command instanceof GetMetricDataCommand) {
        return {
          $metadata: {},
          MetricDataResults: ids.map((Id, index) => ({
            Id,
            StatusCode: "Complete",
            Timestamps: [timestamps[index]],
            Values: [values[index]],
          })),
        };
      }
      if (command instanceof PutMetricDataCommand) return { $metadata: {} };
      throw new Error("unexpected command");
    },
  } as CloudWatchSender;
  return { cloudwatch, commands };
}

function assertSafeBoundaryFailure(failure: unknown, secrets: readonly string[]): void {
  expect(failure).toBeInstanceOf(Error);
  const error = failure as Error;
  expect(error.name).toBe("SafeHandlerError");
  expect(error.message).toBe("Cloud handler invocation failed");
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(["message", "name", "stack"].sort());
  expect(error).not.toHaveProperty("cause");
  for (const secret of secrets) expect(`${error.name} ${error.message} ${JSON.stringify(error)}`).not.toContain(secret);
}

describe("runWatchdog", () => {
  it("evaluates both targets and publishes once", async () => {
    const { cloudwatch, commands } = successfulSender();
    const result = await runWatchdog({ cloudwatch, now: () => now });
    expect(result.targetsEvaluated).toBe(2);
    expect(commands.filter((command) => command instanceof PutMetricDataCommand)).toHaveLength(1);
  });

  it("counts unhealthy gauges rather than unhealthy targets", async () => {
    const { cloudwatch, commands } = successfulSender([0, 1, 0, 1]);
    const result = await runWatchdog({ cloudwatch, now: () => now });
    const publication = commands.find((command) => command instanceof PutMetricDataCommand) as PutMetricDataCommand;
    const unhealthyGaugeCount = publication.input.MetricData!.filter(({ Value }) => Value === 1).length;
    expect(result).toEqual({ targetsEvaluated: 2, unhealthyGaugeCount });
    expect(unhealthyGaugeCount).toBe(2);
  });

  it("does not publish when success exists without unprocessed data", async () => {
    const commands: unknown[] = [];
    const cloudwatch = {
      send: async (command: unknown) => {
        commands.push(command);
        return {
          $metadata: {},
          MetricDataResults: ids.map((Id) => ({
            Id,
            StatusCode: "Complete",
            Timestamps: Id === "target0success" ? [new Date("2026-08-15T12:00:00.000Z")] : [],
            Values: Id === "target0success" ? [1] : [],
          })),
        };
      },
    } as CloudWatchSender;
    await expect(runWatchdog({ cloudwatch, now: () => now })).rejects.toBeInstanceOf(Error);
    expect(commands.filter((command) => command instanceof PutMetricDataCommand)).toHaveLength(0);
  });
});

describe("createHandler", () => {
  it("logs one successful closed completion with handler-owned cold and warm timing", async () => {
    const { cloudwatch } = successfulSender();
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const times = [100, 102.4, 105.6, 10_000, 10_007.4];
    let cold = true;
    const invocation = createHandler(() => {
      if (cold) { cold = false; times.shift(); }
      return { cloudwatch, now: () => now };
    }, () => times.shift()!);
    try {
      expect(await invocation()).toEqual({ targetsEvaluated: 2, unhealthyGaugeCount: 0 });
      expect(await invocation()).toEqual({ targetsEvaluated: 2, unhealthyGaugeCount: 0 });
    } finally {
      consoleSpy.mockRestore();
    }
    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records.map(({ status, durationMs, count, unprocessedCount }) => ({ status, durationMs, count, unprocessedCount }))).toEqual([
      { status: "success", durationMs: 6, count: 2, unprocessedCount: 0 },
      { status: "success", durationMs: 7, count: 2, unprocessedCount: 0 },
    ]);
    for (const record of records) {
      expect(record.component).toBe("schedule-watchdog");
      expect(record.eventCode).toBe("SCHEDULED_RUN_COMPLETED");
      expect(Object.keys(record).sort()).toEqual(["component", "count", "durationMs", "eventCode", "level", "status", "unprocessedCount"].sort());
    }
  });

  it("logs zero counters when reading fails before evaluation", async () => {
    const secrets = ["AwsPrivateError", "private@example.test", "+1-555-0100", "Jane Roe", "secret-token", "raw payload"];
    const failure = Object.assign(new Error(secrets.slice(1).join(" ")), { name: secrets[0], cause: { payload: secrets[5] } });
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const cloudwatch = {
      send: async (command: unknown) => {
        if (command instanceof GetMetricDataCommand) throw failure;
        throw new Error("unexpected command");
      },
    } as CloudWatchSender;
    const invocation = createHandler(() => ({ cloudwatch, now: () => now }), () => 20);
    try {
      const first = await invocation().then(() => undefined, (error: unknown) => error);
      const second = await invocation().then(() => undefined, (error: unknown) => error);
      assertSafeBoundaryFailure(first, secrets);
      assertSafeBoundaryFailure(second, secrets);
      expect(first).not.toBe(second);
    } finally {
      consoleSpy.mockRestore();
    }
    expect(output).toHaveLength(2);
    for (const line of output) {
      expect(JSON.parse(line)).toMatchObject({ component: "schedule-watchdog", status: "failure", count: 0, unprocessedCount: 0, durationMs: 0 });
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });

  it("preserves evaluated target and unhealthy gauge counters when publication fails", async () => {
    const secrets = ["AwsPrivateError", "private@example.test", "+1-555-0100", "Jane Roe", "secret-token", "raw payload"];
    const failure = Object.assign(new Error(secrets.slice(1).join(" ")), { name: secrets[0], cause: { payload: secrets[5] } });
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const base = successfulSender([0, 1, 0, 1]).cloudwatch;
    const cloudwatch = {
      send: async (command: unknown) => {
        if (command instanceof PutMetricDataCommand) throw failure;
        return base.send(command as never);
      },
    } as CloudWatchSender;
    const invocation = createHandler(() => ({ cloudwatch, now: () => now }), () => 20);
    try {
      const first = await invocation().then(() => undefined, (error: unknown) => error);
      const second = await invocation().then(() => undefined, (error: unknown) => error);
      assertSafeBoundaryFailure(first, secrets);
      assertSafeBoundaryFailure(second, secrets);
      expect(first).not.toBe(second);
    } finally {
      consoleSpy.mockRestore();
    }
    expect(output).toHaveLength(2);
    for (const line of output) {
      expect(JSON.parse(line)).toMatchObject({ component: "schedule-watchdog", status: "failure", count: 2, unprocessedCount: 2, durationMs: 0 });
      for (const secret of secrets) expect(line).not.toContain(secret);
    }
  });

  it("safely closes evaluator failures without publishing", async () => {
    const commands: unknown[] = [];
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const cloudwatch = {
      send: async (command: unknown) => {
        commands.push(command);
        return {
          $metadata: {},
          MetricDataResults: ids.map((Id) => ({ Id, StatusCode: "Complete", Timestamps: Id === ids[0] ? [new Date("2026-08-15T12:00:00.000Z")] : [], Values: Id === ids[0] ? [1] : [] })),
        };
      },
    } as CloudWatchSender;
    const invocation = createHandler(() => ({ cloudwatch, now: () => now }), () => 10);
    try {
      const failure = await invocation().then(() => undefined, (error: unknown) => error);
      assertSafeBoundaryFailure(failure, ["missing unprocessed metric"]);
    } finally {
      consoleSpy.mockRestore();
    }
    expect(commands.some((command) => command instanceof PutMetricDataCommand)).toBe(false);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "failure", count: 0, unprocessedCount: 0 });
  });

  it("retains first-target progress when the second target evaluation fails", async () => {
    const commands: unknown[] = [];
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const cloudwatch = {
      send: async (command: unknown) => {
        commands.push(command);
        return {
          $metadata: {},
          MetricDataResults: ids.map((Id) => ({
            Id,
            StatusCode: "Complete",
            Timestamps: Id === "target1success" ? [new Date("2026-08-15T12:00:00.000Z")] : [],
            Values: Id === "target1success" ? [1] : [],
          })),
        };
      },
    } as CloudWatchSender;
    const invocation = createHandler(() => ({ cloudwatch, now: () => now }), () => 10);
    try {
      const failure = await invocation().then(() => undefined, (error: unknown) => error);
      assertSafeBoundaryFailure(failure, ["missing unprocessed metric"]);
    } finally {
      consoleSpy.mockRestore();
    }
    expect(commands.some((command) => command instanceof PutMetricDataCommand)).toBe(false);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({
      status: "failure",
      count: 1,
      unprocessedCount: 1,
    });
  });
});
