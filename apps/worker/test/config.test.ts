import { describe, expect, it } from 'vitest';
import { WORKER_SCHEMA_RANGE } from '@fss/domain/db';
import { ConfigError, describeWorkerConfig, readWorkerConfig } from '../src/bootstrap/config.ts';

/**
 * The worker's environment contract.
 *
 * The task definition in `infra/modules/cluster/main.tf` is the other half of this
 * file: it sets `FSS_ROLE`, `FSS_SCHEMA_MIN`, `FSS_SCHEMA_MAX`, `FSS_METRIC_NAMESPACE`
 * and `AWS_REGION`, and injects the database secret's *value* into
 * `DATABASE_SECRET_ARN`. Everything below is what happens when one of those is wrong,
 * and the answer is always the same: refuse at startup, and name the variable rather
 * than its value.
 */

const base = Object.freeze({
  FSS_ROLE: 'worker',
  FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
  FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
  FSS_METRIC_NAMESPACE: 'FSS',
  AWS_REGION: 'us-east-1',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/fss',
});

describe('worker configuration', () => {
  it('reads the defaults the specification names', () => {
    const config = readWorkerConfig(base);
    expect(config.role).toBe('worker');
    // 13.1: "Once per minute, one bounded pass".
    expect(config.schedulerIntervalMilliseconds).toBe(60_000);
    // The brief: concurrency 1 by default, configurable.
    expect(config.concurrency).toBe(1);
    expect(config.metricsIntervalMilliseconds).toBe(60_000);
    expect(config.metrics.namespace).toBe('FSS');
    expect(config.metrics.region).toBe('us-east-1');
    // The container health check in infra/modules/cluster stats exactly this path.
    expect(config.livenessFilePath).toBe('/tmp/fss-worker-heartbeat');
    expect(config.expectedSystemGeneration).toBeNull();
  });

  it('refuses a declared schema range that disagrees with the binary', () => {
    // The task definition says this image accepts 1-1; the image accepts 2-2. One of
    // the two is a stale deployment, and neither is safe to guess between.
    const attempt = (): unknown => readWorkerConfig({ ...base, FSS_SCHEMA_MIN: '1', FSS_SCHEMA_MAX: '1' });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/FSS_SCHEMA_MIN/);
  });

  it('refuses a concurrency that is not a positive integer, without echoing it', () => {
    let thrown: unknown = null;
    try {
      readWorkerConfig({ ...base, FSS_WORKER_CONCURRENCY: '0' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).code).toBe('INVALID');
    expect((thrown as Error).message).toContain('FSS_WORKER_CONCURRENCY');
  });

  it('accepts the database secret value the task definition injects', () => {
    const config = readWorkerConfig({
      FSS_ROLE: 'worker',
      FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
      FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
      DATABASE_SECRET_ARN: JSON.stringify({
        username: 'app runtime',
        password: 'p@ss/word',
        host: 'db.internal',
        port: 5432,
        dbname: 'fss',
      }),
    });
    // Every component is percent-encoded: a password with a slash in it must not
    // become part of the path.
    expect(config.database.connectionString).toBe('postgresql://app%20runtime:p%40ss%2Fword@db.internal:5432/fss');
  });

  it('refuses an ARN where the task definition should have injected the value', () => {
    const attempt = (): unknown =>
      readWorkerConfig({
        FSS_ROLE: 'worker',
        FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
        FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
        DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:fss-database',
      });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/DATABASE_SECRET_ARN/);
  });

  it('refuses a worker with no database at all', () => {
    expect(() => readWorkerConfig({ FSS_ROLE: 'worker' })).toThrow(ConfigError);
  });

  it('never puts the connection string in the line it logs at startup', () => {
    const config = readWorkerConfig({ ...base, FSS_WORKER_CONCURRENCY: '3', FSS_EXPECTED_SYSTEM_GENERATION: '7' });
    const described = JSON.stringify(describeWorkerConfig(config));
    expect(described).not.toContain('pw');
    expect(described).not.toContain('db.internal');
    expect(described).not.toContain('postgresql://');
    expect(described).toContain('"concurrency":3');
    expect(described).toContain('"expectedSystemGeneration":7');
  });

  it('turns metric publication off when the environment says off', () => {
    expect(readWorkerConfig({ ...base, FSS_METRICS: 'off' }).metrics.mode).toBe('off');
    // Nothing is published when the region is unknown either: an alarm that never
    // fires is better discovered at startup than during an incident.
    expect(readWorkerConfig({ ...base, AWS_REGION: undefined }).metrics.region).toBeNull();
  });
});
