import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  MONTHLY_TARGETS,
  eligibleDueInstants,
  evaluateMonthlyHealth,
  type MetricSample,
  type MonthlyTargetSamples,
} from "../src/monthlyHealth";

const sample = (iso: string, value: number): MetricSample => ({
  timestamp: new Date(iso),
  value,
});

const samples = (
  success: readonly MetricSample[],
  unprocessed: readonly MetricSample[],
): MonthlyTargetSamples => ({ success, unprocessed });

const pvd = MONTHLY_TARGETS[0];
const boston = MONTHLY_TARGETS[1];

describe("MONTHLY_TARGETS", () => {
  it("closes monthly health evaluation to the Providence and Boston schedules", () => {
    expect(MONTHLY_TARGETS).toEqual([
      {
        component: "adapter-pvd-taxroll",
        dayOfMonth: 1,
        hourUtc: 9,
        minuteUtc: 0,
        graceHours: 6,
      },
      {
        component: "adapter-boston-assessments",
        dayOfMonth: 2,
        hourUtc: 11,
        minuteUtc: 0,
        graceHours: 6,
      },
    ]);
  });
});

describe("eligibleDueInstants", () => {
  it("rolls January back to December of the previous year", () => {
    const [olderDue, newerDue] = eligibleDueInstants(
      pvd,
      new Date("2027-01-10T18:00:00.000Z"),
    );

    expect(olderDue.toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(newerDue.toISOString()).toBe("2027-01-01T09:00:00.000Z");
  });

  it("crosses a 28-day February using UTC month arithmetic", () => {
    const [olderDue, newerDue] = eligibleDueInstants(
      boston,
      new Date("2026-03-10T18:00:00.000Z"),
    );

    expect(olderDue.toISOString()).toBe("2026-02-02T11:00:00.000Z");
    expect(newerDue.toISOString()).toBe("2026-03-02T11:00:00.000Z");
    expect(newerDue.getTime() - olderDue.getTime()).toBe(28 * 24 * 60 * 60 * 1000);
  });

  it("crosses February 29 in a leap year using UTC month arithmetic", () => {
    const [olderDue, newerDue] = eligibleDueInstants(
      boston,
      new Date("2028-03-10T18:00:00.000Z"),
    );

    expect(olderDue.toISOString()).toBe("2028-02-02T11:00:00.000Z");
    expect(newerDue.toISOString()).toBe("2028-03-02T11:00:00.000Z");
    expect(newerDue.getTime() - olderDue.getTime()).toBe(29 * 24 * 60 * 60 * 1000);
  });

  it("crosses from a 30-day month to a 31-day month", () => {
    const [olderDue, newerDue] = eligibleDueInstants(
      pvd,
      new Date("2026-05-10T18:00:00.000Z"),
    );

    expect(olderDue.toISOString()).toBe("2026-04-01T09:00:00.000Z");
    expect(newerDue.toISOString()).toBe("2026-05-01T09:00:00.000Z");
    expect(newerDue.getTime() - olderDue.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("crosses a 31-day month using UTC month arithmetic", () => {
    const [olderDue, newerDue] = eligibleDueInstants(
      pvd,
      new Date("2026-08-10T18:00:00.000Z"),
    );

    expect(olderDue.toISOString()).toBe("2026-07-01T09:00:00.000Z");
    expect(newerDue.toISOString()).toBe("2026-08-01T09:00:00.000Z");
    expect(newerDue.getTime() - olderDue.getTime()).toBe(31 * 24 * 60 * 60 * 1000);
  });

  it("does not make a due instant eligible one millisecond before grace ends", () => {
    const [olderDue, newerDue] = eligibleDueInstants(
      pvd,
      new Date("2026-07-01T14:59:59.999Z"),
    );

    expect(olderDue.toISOString()).toBe("2026-05-01T09:00:00.000Z");
    expect(newerDue.toISOString()).toBe("2026-06-01T09:00:00.000Z");
  });

  it("makes a due instant eligible exactly when grace ends", () => {
    const [olderDue, newerDue] = eligibleDueInstants(
      pvd,
      new Date("2026-07-01T15:00:00.000Z"),
    );

    expect(olderDue.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(newerDue.toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });

  it("rejects an invalid current instant", () => {
    expect(() => eligibleDueInstants(pvd, new Date(Number.NaN))).toThrow(
      "invalid date",
    );
  });
});

describe("evaluateMonthlyHealth", () => {
  const now = new Date("2026-09-10T18:00:00.000Z");

  it("detects two missed monthly expected runs", () => {
    const result = evaluateMonthlyHealth(pvd, samples([], []), now);

    expect(result).toMatchObject({
      component: "adapter-pvd-taxroll",
      missingSuccess: true,
      persistentUnprocessed: false,
    });
    expect(result.olderDue.toISOString()).toBe("2026-08-01T09:00:00.000Z");
    expect(result.newerDue.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  it("does not count zero-valued samples as positive success", () => {
    const result = evaluateMonthlyHealth(
      pvd,
      samples(
        [
          sample("2026-08-15T12:00:00.000Z", 0),
          sample("2026-09-05T12:00:00.000Z", 0),
        ],
        [],
      ),
      now,
    );

    expect(result.missingSuccess).toBe(true);
    expect(result.persistentUnprocessed).toBe(false);
  });

  it("does not report two misses when only the newer window lacks success", () => {
    const result = evaluateMonthlyHealth(
      pvd,
      samples(
        [sample("2026-08-15T12:00:00.000Z", 1)],
        [sample("2026-08-15T12:00:00.000Z", 0)],
      ),
      now,
    );

    expect(result.missingSuccess).toBe(false);
    expect(result.persistentUnprocessed).toBe(false);
  });

  it("counts a manual retry success inside the newer window", () => {
    const result = evaluateMonthlyHealth(
      pvd,
      samples(
        [sample("2026-09-05T16:30:00.000Z", 1)],
        [sample("2026-09-05T16:30:00.000Z", 0)],
      ),
      now,
    );

    expect(result.missingSuccess).toBe(false);
    expect(result.persistentUnprocessed).toBe(false);
  });

  it("reports persistent unprocessed work when both successful windows have positive minima", () => {
    const result = evaluateMonthlyHealth(
      pvd,
      samples(
        [
          sample("2026-08-15T12:00:00.000Z", 1),
          sample("2026-09-05T12:00:00.000Z", 1),
        ],
        [
          sample("2026-08-15T12:00:00.000Z", 3),
          sample("2026-08-20T12:00:00.000Z", 2),
          sample("2026-09-05T12:00:00.000Z", 4),
          sample("2026-09-06T12:00:00.000Z", 1),
        ],
      ),
      now,
    );

    expect(result.persistentUnprocessed).toBe(true);
  });

  it.each([
    [
      "older",
      [sample("2026-08-15T12:00:00.000Z", 0), sample("2026-09-05T12:00:00.000Z", 2)],
    ],
    [
      "newer",
      [sample("2026-08-15T12:00:00.000Z", 2), sample("2026-09-05T12:00:00.000Z", 0)],
    ],
  ])("clears persistence when the %s successful window contains zero", (_window, unprocessed) => {
    const result = evaluateMonthlyHealth(
      pvd,
      samples(
        [
          sample("2026-08-15T12:00:00.000Z", 1),
          sample("2026-09-05T12:00:00.000Z", 1),
        ],
        unprocessed,
      ),
      now,
    );

    expect(result.persistentUnprocessed).toBe(false);
  });

  it("fails closed when an older-window success lacks an unprocessed sample", () => {
    expect(() =>
      evaluateMonthlyHealth(
        pvd,
        samples([sample("2026-08-15T12:00:00.000Z", 1)], []),
        now,
      ),
    ).toThrow("missing unprocessed metric for successful older monthly window");
  });

  it("fails closed when a newer-window success lacks an unprocessed sample", () => {
    expect(() =>
      evaluateMonthlyHealth(
        pvd,
        samples([sample("2026-09-05T12:00:00.000Z", 1)], []),
        now,
      ),
    ).toThrow("missing unprocessed metric for successful newer monthly window");
  });

  it("uses olderDue inclusively and newerDue exclusively for the older window", () => {
    expect(() =>
      evaluateMonthlyHealth(
        pvd,
        samples(
          [sample("2026-08-01T09:00:00.000Z", 1)],
          [sample("2026-09-01T09:00:00.000Z", 0)],
        ),
        now,
      ),
    ).toThrow("missing unprocessed metric for successful older monthly window");
  });

  it("uses newerDue inclusively and does not include olderDue in the newer window", () => {
    expect(() =>
      evaluateMonthlyHealth(
        pvd,
        samples(
          [sample("2026-09-01T09:00:00.000Z", 1)],
          [sample("2026-08-01T09:00:00.000Z", 0)],
        ),
        now,
      ),
    ).toThrow("missing unprocessed metric for successful newer monthly window");
  });

  it("includes samples exactly at now in the newer window", () => {
    const result = evaluateMonthlyHealth(
      pvd,
      samples(
        [sample("2026-09-10T18:00:00.000Z", 1)],
        [sample("2026-09-10T18:00:00.000Z", 0)],
      ),
      now,
    );

    expect(result.missingSuccess).toBe(false);
  });

  it.each(["success", "unprocessed"] as const)(
    "rejects every invalid %s sample before window filtering",
    (metric) => {
      const invalidSamples: MetricSample[] = [
        { timestamp: new Date(Number.NaN), value: 1 },
        sample("2000-01-01T00:00:00.000Z", -1),
        sample("2000-01-01T00:00:00.000Z", Number.NaN),
        sample("2000-01-01T00:00:00.000Z", Number.POSITIVE_INFINITY),
        sample("2000-01-01T00:00:00.000Z", "1" as unknown as number),
      ];

      for (const invalidSample of invalidSamples) {
        const targetSamples =
          metric === "success"
            ? samples([invalidSample], [])
            : samples([], [invalidSample]);

        expect(() => evaluateMonthlyHealth(pvd, targetSamples, now)).toThrow();
      }
    },
  );

  it("rejects an invalid current instant", () => {
    expect(() =>
      evaluateMonthlyHealth(pvd, samples([], []), new Date(Number.NaN)),
    ).toThrow("invalid date");
  });
});

describe("purity regressions", () => {
  it("guards the evaluator source against forbidden runtime integrations and clocks", () => {
    const source = readFileSync(
      new URL("../src/monthlyHealth.ts", import.meta.url),
      "utf8",
    );
    const forbiddenPatterns = [
      [
        "AWS, provider, or client imports and construction",
        /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'][^"']*(?:@aws-sdk|aws-sdk|provider|client)[^"']*["']|\bnew\s+\w*Client\s*\(/i,
      ],
      ["environment access", /\bprocess\s*\.\s*env\b/],
      [
        "runtime network access",
        /\bfetch\s*\(|\b(?:XMLHttpRequest|WebSocket)\b|\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](?:node:)?(?:http|https|net|tls|dgram|undici)(?:\/[^"']*)?["']/i,
      ],
      [
        "filesystem imports or access",
        /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'](?:node:)?fs(?:\/promises)?["']|\b(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|readdir|readdirSync|stat|statSync|openSync)\s*\(/i,
      ],
      [
        "logger or console access",
        /\bconsole\s*\.|\blogger\s*\.|\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["'][^"']*(?:log|logger)[^"']*["']/i,
      ],
      [
        "global clock lookup",
        /\b(?:Date\s*\.\s*now|performance\s*\.\s*now|process\s*\.\s*hrtime)\s*\(|\bnew\s+Date\s*\(\s*\)/,
      ],
    ] as const;

    for (const [description, pattern] of forbiddenPatterns) {
      expect(source, description).not.toMatch(pattern);
    }
  });

  it("does not read the global clock or mutate target, samples, timestamps, or now", () => {
    const target = Object.freeze({ ...pvd });
    const successTimestamp = new Date("2026-08-15T12:00:00.000Z");
    const unprocessedTimestamp = new Date("2026-08-15T12:00:00.000Z");
    const successSample = Object.freeze({
      timestamp: successTimestamp,
      value: 1,
    });
    const unprocessedSample = Object.freeze({
      timestamp: unprocessedTimestamp,
      value: 0,
    });
    const success = Object.freeze([successSample]);
    const unprocessed = Object.freeze([unprocessedSample]);
    const targetSamples: MonthlyTargetSamples = Object.freeze({
      success,
      unprocessed,
    });
    const now = new Date("2026-09-10T18:00:00.000Z");
    const original = {
      target: { ...target },
      successTimestamp: successTimestamp.getTime(),
      unprocessedTimestamp: unprocessedTimestamp.getTime(),
      now: now.getTime(),
    };
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("global clock accessed");
    });

    try {
      const dueInstants = eligibleDueInstants(target, now);
      const result = evaluateMonthlyHealth(target, targetSamples, now);

      expect(dateNow).not.toHaveBeenCalled();
      expect(dueInstants.map((instant) => instant.toISOString())).toEqual([
        "2026-08-01T09:00:00.000Z",
        "2026-09-01T09:00:00.000Z",
      ]);
      expect(result.missingSuccess).toBe(false);
      expect(target).toEqual(original.target);
      expect(targetSamples.success).toBe(success);
      expect(targetSamples.unprocessed).toBe(unprocessed);
      expect(successTimestamp.getTime()).toBe(original.successTimestamp);
      expect(unprocessedTimestamp.getTime()).toBe(original.unprocessedTimestamp);
      expect(now.getTime()).toBe(original.now);
    } finally {
      dateNow.mockRestore();
    }
  });
});
