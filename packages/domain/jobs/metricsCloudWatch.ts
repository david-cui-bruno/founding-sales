import {
  metricRejectedError,
  metricRejection,
  publishValidMetricData,
  type MetricDatum,
  type MetricRejection,
  type MetricSink,
  type PutMetricData,
} from './metrics.ts';

/**
 * The one place the AWS SDK is allowed to exist.
 *
 * `metrics.ts` deliberately knows nothing about CloudWatch: it produces validated
 * `MetricDatum`s and takes a `PutMetricData` function. This file is the other side of
 * that seam — the mapping onto the `PutMetricData` API, the batch size the API
 * accepts, and the one lazy import of `@aws-sdk/client-cloudwatch`.
 *
 * The import is lazy for two reasons. The API process never publishes metrics and
 * should not pay to load the SDK, and a laptop with no credentials must be able to run
 * the worker: `createCloudWatchSink` with no transport is a sink that still validates
 * every datum and sends nothing, so a wrong unit or an unknown metric name fails here
 * rather than in production.
 *
 * Nothing in this file reaches AWS during a test. The transport is one method, and
 * `test/jobs/metricsCloudWatch.test.ts` supplies a fake.
 */

/**
 * `PutMetricData` accepts at most twenty `MetricData` members per request. The
 * published limit has been raised for some request shapes; twenty is the one that has
 * always been safe and the publication is a handful of gauges a minute.
 */
export const CLOUDWATCH_MAX_DATA_PER_REQUEST = 20;

export interface CloudWatchDimension {
  readonly Name: string;
  readonly Value: string;
}

export interface CloudWatchDatum {
  readonly MetricName: string;
  readonly Value: number;
  readonly Unit: string;
  readonly Timestamp: Date;
  readonly Dimensions?: readonly CloudWatchDimension[];
}

export interface PutMetricDataInput {
  readonly Namespace: string;
  readonly MetricData: readonly CloudWatchDatum[];
}

/** What the SDK is narrowed to. One method, so a fake is three lines. */
export interface CloudWatchTransport {
  send(input: PutMetricDataInput): Promise<void>;
}

export interface CloudWatchOptions {
  readonly now?: (() => Date) | undefined;
}

/** One datum, in the shape `PutMetricData` reads. Dimensions are omitted, not empty. */
export function toCloudWatchDatum(datum: MetricDatum, at: Date): CloudWatchDatum {
  const dimensions = Object.entries(datum.dimensions ?? {}).map(([Name, Value]) => ({ Name, Value }));
  const mapped: CloudWatchDatum = {
    MetricName: datum.name,
    Value: datum.value,
    Unit: datum.unit,
    // One timestamp for the whole publication: the gauges were all read from the same
    // database snapshot, and giving them different instants invents precision.
    Timestamp: at,
  };
  return dimensions.length === 0 ? mapped : { ...mapped, Dimensions: dimensions };
}

/**
 * G5's `PutMetricData`, implemented over a transport, batched to the API's limit.
 *
 * CloudWatch rejects a whole request when one member is invalid. So a rejected batch
 * of more than one datum is retried one datum per request: the good ones are
 * published and the bad ones are named in one `METRIC_REJECTED` error at the end.
 * If every datum fails on its own too, the fault is the transport rather than the
 * data — no credentials, no network — and the batch's error is thrown as it was.
 */
export function cloudWatchPutMetricData(transport: CloudWatchTransport, options: CloudWatchOptions = {}): PutMetricData {
  const now = options.now ?? ((): Date => new Date());
  return async (namespace, data) => {
    if (data.length === 0) return;
    const at = now();
    const send = async (batch: readonly MetricDatum[]): Promise<void> => {
      await transport.send({ Namespace: namespace, MetricData: batch.map(datum => toCloudWatchDatum(datum, at)) });
    };
    const rejected: MetricRejection[] = [];
    let published = 0;
    let batchError: unknown = null;
    for (let start = 0; start < data.length; start += CLOUDWATCH_MAX_DATA_PER_REQUEST) {
      const batch = data.slice(start, start + CLOUDWATCH_MAX_DATA_PER_REQUEST);
      try {
        await send(batch);
        published += batch.length;
        continue;
      } catch (error) {
        batchError ??= error;
        if (batch.length === 1) {
          rejected.push(metricRejection(batch[0] as MetricDatum, error));
          continue;
        }
      }
      for (const datum of batch) {
        try {
          await send([datum]);
          published += 1;
        } catch (error) {
          rejected.push(metricRejection(datum, error));
        }
      }
    }
    if (rejected.length === 0) return;
    if (published === 0 && data.length > 1) throw batchError;
    throw metricRejectedError(rejected);
  };
}

export interface CloudWatchSinkOptions extends CloudWatchOptions {
  readonly namespace: string;
  /** Null on a laptop and in every test: the sink then validates and sends nothing. */
  readonly transport: CloudWatchTransport | null;
}

/**
 * A `MetricSink` over CloudWatch. Validation happens before the transport is touched,
 * so an unknown metric name or a unit CloudWatch does not know never leaves the
 * process even when a transport exists — and never stops the valid data beside it
 * from being published. What was refused is named in one `METRIC_REJECTED` error.
 */
export function createCloudWatchSink(options: CloudWatchSinkOptions): MetricSink {
  const publish =
    options.transport === null
      ? null
      : cloudWatchPutMetricData(options.transport, options.now === undefined ? {} : { now: options.now });
  return {
    publish: async (data: readonly MetricDatum[]) => {
      await publishValidMetricData(data, async valid => {
        if (publish === null) return;
        await publish(options.namespace, valid);
      });
    },
  };
}

/**
 * Build the real transport. The only line in the tree that loads an AWS SDK, and the
 * only one that can reach the network.
 *
 * Credentials come from the task role through the SDK's default provider chain; this
 * process never holds, reads or logs one. A region is required: the SDK would
 * otherwise look for one in a profile that does not exist in a container.
 */
export async function loadCloudWatchTransport(region: string): Promise<CloudWatchTransport> {
  const specifier = '@aws-sdk/client-cloudwatch';
  const sdk = (await import(specifier)) as {
    CloudWatchClient: new (configuration: { region: string }) => { send(command: unknown): Promise<unknown> };
    PutMetricDataCommand: new (input: PutMetricDataInput) => unknown;
  };
  const client = new sdk.CloudWatchClient({ region });
  return {
    send: async input => {
      await client.send(new sdk.PutMetricDataCommand(input));
    },
  };
}
