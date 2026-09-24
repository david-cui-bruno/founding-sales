import { describe, expect, it } from 'vitest';
import {
  CLOUDWATCH_MAX_DATA_PER_REQUEST,
  cloudWatchPutMetricData,
  createCloudWatchSink,
  loadCloudWatchTransport,
  type CloudWatchTransport,
  type PutMetricDataInput,
} from '../../jobs/metricsCloudWatch.ts';
import { MetricError, type MetricDatum } from '../../jobs/metrics.ts';

/**
 * The real CloudWatch publisher, with the AWS SDK replaced by a fake transport.
 *
 * Nothing in this file reaches AWS. The transport is the only place the SDK is
 * allowed to live (`metricsCloudWatch.ts`), and it is one `send`; everything worth
 * testing — the mapping onto `PutMetricData`, the batch size, the timestamp, the
 * dimension shape and the refusal of a name no alarm reads — is on this side of it.
 */

function fakeTransport(): CloudWatchTransport & { readonly sent: PutMetricDataInput[]; fail?: Error } {
  const sent: PutMetricDataInput[] = [];
  return {
    sent,
    send: async input => {
      sent.push(input);
      await Promise.resolve();
    },
  };
}

const at = new Date('2026-09-20T12:00:00.000Z');

describe('the CloudWatch metric publisher', () => {
  it('maps a datum onto the PutMetricData shape the alarms read', async () => {
    const transport = fakeTransport();
    const put = cloudWatchPutMetricData(transport, { now: () => at });
    await put('FSS', [{ name: 'WorkerHeartbeat', value: 1, unit: 'Count', dimensions: { Service: 'worker' } }]);

    expect(transport.sent).toEqual([
      {
        Namespace: 'FSS',
        MetricData: [
          {
            MetricName: 'WorkerHeartbeat',
            Value: 1,
            Unit: 'Count',
            Timestamp: at,
            Dimensions: [{ Name: 'Service', Value: 'worker' }],
          },
        ],
      },
    ]);
  });

  it('omits Dimensions entirely when there are none', async () => {
    const transport = fakeTransport();
    await cloudWatchPutMetricData(transport, { now: () => at })('FSS', [
      { name: 'OldestRunnableJobAgeSeconds', value: 12.5, unit: 'Seconds' },
    ]);
    expect(transport.sent[0]?.MetricData[0]).not.toHaveProperty('Dimensions');
  });

  it('splits a publication into batches PutMetricData accepts', async () => {
    const transport = fakeTransport();
    const data: MetricDatum[] = Array.from({ length: CLOUDWATCH_MAX_DATA_PER_REQUEST * 2 + 1 }, () => ({
      name: 'CanaryCompletionAgeSeconds',
      value: 1,
      unit: 'Seconds' as const,
    }));
    await cloudWatchPutMetricData(transport, { now: () => at })('FSS', data);
    expect(transport.sent.map(request => request.MetricData.length)).toEqual([
      CLOUDWATCH_MAX_DATA_PER_REQUEST,
      CLOUDWATCH_MAX_DATA_PER_REQUEST,
      1,
    ]);
  });

  it('sends nothing at all when there is nothing to say', async () => {
    const transport = fakeTransport();
    await cloudWatchPutMetricData(transport, { now: () => at })('FSS', []);
    expect(transport.sent).toEqual([]);
  });

  it('refuses a metric name no alarm reads, before any transport call', async () => {
    const transport = fakeTransport();
    const sink = createCloudWatchSink({ namespace: 'FSS', transport, now: () => at });
    await expect(
      sink.publish([{ name: 'MadeUpMetric', value: 1, unit: 'Count' } as unknown as MetricDatum]),
    ).rejects.toBeInstanceOf(MetricError);
    expect(transport.sent).toEqual([]);
  });

  it('is a validating no-op when no transport exists, so a laptop behaves like production', async () => {
    const sink = createCloudWatchSink({ namespace: 'FSS', transport: null, now: () => at });
    await expect(sink.publish([{ name: 'WorkerHeartbeat', value: 1, unit: 'Count' }])).resolves.toBeUndefined();
    await expect(
      sink.publish([{ name: 'NotAMetric', value: 1, unit: 'Count' } as unknown as MetricDatum]),
    ).rejects.toBeInstanceOf(MetricError);
  });

  it('publishes the rest when one datum carries a unit CloudWatch does not know', async () => {
    // The 24 September 2026 publication: the sixth datum was the first connected
    // mailbox's watch gauge, in `Hours`. It is now refused here, by name, and the
    // five in front of it still go out.
    const transport = fakeTransport();
    const sink = createCloudWatchSink({ namespace: 'FSS', transport, now: () => at });
    const data = [
      { name: 'WorkerHeartbeat', value: 1, unit: 'Count' },
      { name: 'SchedulerHeartbeat', value: 1, unit: 'Count' },
      { name: 'ApiHeartbeat', value: 1, unit: 'Count' },
      { name: 'MailboxCheckHeartbeat', value: 1, unit: 'Count' },
      { name: 'CanaryCompletionAgeSeconds', value: 4, unit: 'Seconds' },
      { name: 'GmailWatchHoursToExpiry', value: 167.5, unit: 'Hours' },
    ] as unknown as MetricDatum[];

    const refused = await sink.publish(data).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(MetricError);
    expect((refused as MetricError).code).toBe('METRIC_REJECTED');
    expect((refused as MetricError).rejected).toEqual([
      expect.objectContaining({ name: 'GmailWatchHoursToExpiry', unit: 'Hours', errorName: 'METRIC_UNIT_INVALID' }),
    ]);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.MetricData.map(datum => datum.MetricName)).toEqual([
      'WorkerHeartbeat',
      'SchedulerHeartbeat',
      'ApiHeartbeat',
      'MailboxCheckHeartbeat',
      'CanaryCompletionAgeSeconds',
    ]);
  });

  it('retries a rejected batch one datum at a time, and names the datum CloudWatch refused', async () => {
    const sent: PutMetricDataInput[] = [];
    const rejecting: CloudWatchTransport = {
      send: async input => {
        await Promise.resolve();
        if (input.MetricData.some(datum => datum.MetricName === 'MailboxDisconnectedHours')) {
          const error = new Error('The parameter MetricData.member.3.Unit must be a value in the set');
          error.name = 'InvalidParameterValueException';
          throw error;
        }
        sent.push(input);
      },
    };
    const put = cloudWatchPutMetricData(rejecting, { now: () => at });
    const refused = await put('FSS', [
      { name: 'WorkerHeartbeat', value: 1, unit: 'Count' },
      { name: 'SchedulerHeartbeat', value: 1, unit: 'Count' },
      { name: 'MailboxDisconnectedHours', value: 50, unit: 'None' },
      { name: 'GmailWatchHoursToExpiry', value: 100, unit: 'None' },
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(MetricError);
    expect((refused as MetricError).rejected).toEqual([
      expect.objectContaining({ name: 'MailboxDisconnectedHours', errorName: 'InvalidParameterValueException' }),
    ]);
    expect(sent.flatMap(request => request.MetricData.map(datum => datum.MetricName))).toEqual([
      'WorkerHeartbeat',
      'SchedulerHeartbeat',
      'GmailWatchHoursToExpiry',
    ]);
  });

  it('throws the transport error itself when nothing at all could be sent', async () => {
    const down: CloudWatchTransport = {
      send: async () => {
        await Promise.resolve();
        throw new Error('getaddrinfo ENOTFOUND monitoring.us-east-1.amazonaws.com');
      },
    };
    const put = cloudWatchPutMetricData(down, { now: () => at });
    const refused = await put('FSS', [
      { name: 'WorkerHeartbeat', value: 1, unit: 'Count' },
      { name: 'SchedulerHeartbeat', value: 1, unit: 'Count' },
    ]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(MetricError);
  });

  it('resolves the SDK the lazy import names', async () => {
    // Construction only. The SDK resolves credentials and opens a connection when a
    // command is sent, and no command is sent here: this asserts the one thing a lazy
    // import can break silently, which is that the specifier is still installed.
    const transport = await loadCloudWatchTransport('us-east-1');
    expect(typeof transport.send).toBe('function');
  });
});
