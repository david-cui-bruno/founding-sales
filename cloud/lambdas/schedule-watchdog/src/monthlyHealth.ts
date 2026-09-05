const HOUR_MS = 60 * 60 * 1000;

export const MONTHLY_TARGETS = [
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
] as const;

export type MonthlyTarget = (typeof MONTHLY_TARGETS)[number];

export interface MetricSample {
  timestamp: Date;
  value: number;
}

export interface MonthlyTargetSamples {
  success: readonly MetricSample[];
  unprocessed: readonly MetricSample[];
}

export interface MonthlyHealthEvaluation {
  component: MonthlyTarget["component"];
  olderDue: Date;
  newerDue: Date;
  missingSuccess: boolean;
  persistentUnprocessed: boolean;
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("invalid date");
  }
}

function assertValidSamples(samples: readonly MetricSample[]): void {
  for (const sample of samples) {
    assertValidDate(sample.timestamp);
    if (
      typeof sample.value !== "number" ||
      !Number.isFinite(sample.value) ||
      sample.value < 0
    ) {
      throw new Error("invalid metric sample value");
    }
  }
}

function scheduledInstant(
  target: MonthlyTarget,
  year: number,
  monthIndex: number,
): Date {
  return new Date(
    Date.UTC(
      year,
      monthIndex,
      target.dayOfMonth,
      target.hourUtc,
      target.minuteUtc,
      0,
      0,
    ),
  );
}

function previousMonth(target: MonthlyTarget, instant: Date): Date {
  return scheduledInstant(
    target,
    instant.getUTCFullYear(),
    instant.getUTCMonth() - 1,
  );
}

export function eligibleDueInstants(
  target: MonthlyTarget,
  now: Date,
): readonly [Date, Date] {
  assertValidDate(now);
  let newerDue = scheduledInstant(
    target,
    now.getUTCFullYear(),
    now.getUTCMonth(),
  );
  if (newerDue.getTime() + target.graceHours * HOUR_MS > now.getTime()) {
    newerDue = previousMonth(target, newerDue);
  }
  return [previousMonth(target, newerDue), newerDue] as const;
}

function valuesInWindow(
  samples: readonly MetricSample[],
  start: Date,
  end: Date,
  inclusiveEnd: boolean,
): number[] {
  const startTime = start.getTime();
  const endTime = end.getTime();
  return samples
    .filter(({ timestamp }) => {
      const timestampTime = timestamp.getTime();
      return (
        timestampTime >= startTime &&
        (inclusiveEnd ? timestampTime <= endTime : timestampTime < endTime)
      );
    })
    .map(({ value }) => value);
}

function positiveValuesInWindow(
  samples: readonly MetricSample[],
  start: Date,
  end: Date,
  inclusiveEnd: boolean,
): number[] {
  return valuesInWindow(samples, start, end, inclusiveEnd).filter(
    (value) => value > 0,
  );
}

export function evaluateMonthlyHealth(
  target: MonthlyTarget,
  samples: MonthlyTargetSamples,
  now: Date,
): MonthlyHealthEvaluation {
  const [olderDue, newerDue] = eligibleDueInstants(target, now);
  assertValidSamples(samples.success);
  assertValidSamples(samples.unprocessed);

  const olderSuccess = positiveValuesInWindow(
    samples.success,
    olderDue,
    newerDue,
    false,
  );
  const newerSuccess = positiveValuesInWindow(
    samples.success,
    newerDue,
    now,
    true,
  );
  const olderUnprocessed = valuesInWindow(
    samples.unprocessed,
    olderDue,
    newerDue,
    false,
  );
  const newerUnprocessed = valuesInWindow(
    samples.unprocessed,
    newerDue,
    now,
    true,
  );

  if (olderSuccess.length > 0 && olderUnprocessed.length === 0) {
    throw new Error(
      "missing unprocessed metric for successful older monthly window",
    );
  }
  if (newerSuccess.length > 0 && newerUnprocessed.length === 0) {
    throw new Error(
      "missing unprocessed metric for successful newer monthly window",
    );
  }

  return {
    component: target.component,
    olderDue,
    newerDue,
    missingSuccess: olderSuccess.length === 0 && newerSuccess.length === 0,
    persistentUnprocessed:
      olderSuccess.length > 0 &&
      newerSuccess.length > 0 &&
      Math.min(...olderUnprocessed) > 0 &&
      Math.min(...newerUnprocessed) > 0,
  };
}
