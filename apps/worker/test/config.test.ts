import { describe, expect, it } from 'vitest';
import { WORKER_SCHEMA_RANGE } from '@fss/domain/db';
import { ConfigError, describeWorkerConfig, readWorkerConfig } from '../src/bootstrap/config.ts';

/**
 * The worker's environment contract.
 *
 * The task definition in `infra/modules/cluster/main.tf` is the other half of this
 * file: it sets `FSS_ROLE`, `FSS_SCHEMA_MIN`, `FSS_SCHEMA_MAX`, `FSS_METRIC_NAMESPACE`,
 * `FSS_NAME_PREFIX` and `AWS_REGION`, and injects the database secret's *value* into
 * `DATABASE_SECRET_ARN`. Everything below is what happens when one of those is wrong,
 * and the answer is always the same: refuse at startup, and name the variable rather
 * than its value.
 */

const base = Object.freeze({
  FSS_ROLE: 'worker',
  FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
  FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
  FSS_METRIC_NAMESPACE: 'FSS/fss-test',
  FSS_NAME_PREFIX: 'fss-test',
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
    expect(config.metrics.namespace).toBe('FSS/fss-test');
    expect(config.metrics.region).toBe('us-east-1');
    // The container health check in infra/modules/cluster stats exactly this path.
    expect(config.livenessFilePath).toBe('/tmp/fss-worker-heartbeat');
    expect(config).not.toHaveProperty('expectedSystemGeneration');
  });

  it('refuses a declared schema range that disagrees with the binary', () => {
    // The task definition names the range of the release before this one; the image
    // accepts its own. One of the two is a stale deployment, and neither is safe to
    // guess between.
    const stale = String(WORKER_SCHEMA_RANGE.minimum - 1);
    const attempt = (): unknown => readWorkerConfig({ ...base, FSS_SCHEMA_MIN: stale, FSS_SCHEMA_MAX: stale });
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

  it('connects to FSS_DATABASE_HOST instead of the secret’s host, with the secret’s credential (active_database_host)', () => {
    const secret = JSON.stringify({ username: 'app', password: 'pw', host: 'fss-prod-pg.example.invalid', port: 5432, dbname: 'fss' });
    const environment = {
      FSS_ROLE: 'worker',
      FSS_SCHEMA_MIN: String(WORKER_SCHEMA_RANGE.minimum),
      FSS_SCHEMA_MAX: String(WORKER_SCHEMA_RANGE.maximum),
      DATABASE_SECRET_ARN: secret,
    };
    // The same host as the secret's, which is production today: nothing changes.
    expect(readWorkerConfig({ ...environment, FSS_DATABASE_HOST: 'fss-prod-pg.example.invalid' }).database.connectionString).toBe(
      'postgresql://app:pw@fss-prod-pg.example.invalid:5432/fss',
    );
    // A point-in-time copy the restore runbook pointed every task at.
    expect(readWorkerConfig({ ...environment, FSS_DATABASE_HOST: 'fss-prod-pg-r1.example.invalid' }).database.connectionString).toBe(
      'postgresql://app:pw@fss-prod-pg-r1.example.invalid:5432/fss',
    );
    // A whole URL names its own host and is used as given.
    expect(
      readWorkerConfig({ ...environment, DATABASE_URL: 'postgresql://u@local.test/db', FSS_DATABASE_HOST: 'elsewhere.test' }).database
        .connectionString,
    ).toBe('postgresql://u@local.test/db');
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
    const config = readWorkerConfig({ ...base, FSS_WORKER_CONCURRENCY: '3' });
    const described = JSON.stringify(describeWorkerConfig(config));
    expect(described).not.toContain('pw');
    expect(described).not.toContain('db.internal');
    expect(described).not.toContain('postgresql://');
    expect(described).toContain('"concurrency":3');
  });

  describe('the metric namespace (g42, lane g55)', () => {
    // Every environment in the account used to publish into the bare `FSS`, so the
    // tenth full rehearsal's smoke read production's canary age and production's alarms
    // saw rehearsal data. The namespace is now `FSS/<name prefix>`, set by the task
    // definition, and there is no default for a publishing worker to fall back to.
    const refusal = (environment: Readonly<Record<string, string | undefined>>): ConfigError => {
      try {
        readWorkerConfig(environment);
      } catch (error) {
        if (error instanceof ConfigError) return error;
        throw error;
      }
      throw new Error('the configuration was accepted');
    };

    it('refuses a worker that would publish with no namespace, rather than defaulting to the shared one', () => {
      for (const unset of [undefined, '', '   ']) {
        const error = refusal({ ...base, FSS_METRIC_NAMESPACE: unset });
        expect(error.code).toBe('MISSING');
        expect(error.message).toContain('FSS_METRIC_NAMESPACE');
      }
      // `auto` is the default mode and publishes whenever a region is known, which in a
      // task definition is always.
      expect(refusal({ ...base, FSS_METRICS: 'auto', FSS_METRIC_NAMESPACE: undefined }).code).toBe('MISSING');
      expect(refusal({ ...base, FSS_METRICS: 'on', FSS_METRIC_NAMESPACE: undefined }).code).toBe('MISSING');
    });

    it('refuses the bare FSS namespace, with or without a prefix beside it', () => {
      expect(refusal({ ...base, FSS_METRIC_NAMESPACE: 'FSS' }).code).toBe('INVALID');
      expect(refusal({ ...base, FSS_NAME_PREFIX: undefined, FSS_METRIC_NAMESPACE: 'FSS' }).code).toBe('INVALID');
      expect(refusal({ ...base, FSS_NAME_PREFIX: undefined, FSS_METRIC_NAMESPACE: 'FSS/' }).code).toBe('INVALID');
    });

    it('refuses another environment’s namespace, without repeating it', () => {
      // A rehearsal task definition that names production's namespace is exactly the
      // defect, and the prefix beside it is what makes that visible at startup.
      const error = refusal({ ...base, FSS_NAME_PREFIX: 'fss-rh-202609241713', FSS_METRIC_NAMESPACE: 'FSS/fss-prod' });
      expect(error.code).toBe('INVALID');
      expect(error.message).toContain('FSS_NAME_PREFIX');
      expect(error.message).not.toContain('fss-prod');
      expect(error.message).not.toContain('fss-rh-202609241713');
    });

    it('accepts FSS/<prefix> for production and for a rehearsal run', () => {
      expect(
        readWorkerConfig({ ...base, FSS_NAME_PREFIX: 'fss-prod', FSS_METRIC_NAMESPACE: 'FSS/fss-prod' }).metrics.namespace,
      ).toBe('FSS/fss-prod');
      expect(
        readWorkerConfig({
          ...base,
          FSS_NAME_PREFIX: 'fss-rh-202609241713',
          FSS_METRIC_NAMESPACE: ' FSS/fss-rh-202609241713 ',
        }).metrics.namespace,
      ).toBe('FSS/fss-rh-202609241713');
    });

    it('needs no namespace when nothing will be published', () => {
      // A laptop or a test: metrics off, or no region to publish to. The sink is then
      // a validating no-op and a namespace would name nothing.
      expect(readWorkerConfig({ ...base, FSS_METRICS: 'off', FSS_METRIC_NAMESPACE: undefined }).metrics.namespace).toBeNull();
      expect(
        readWorkerConfig({ ...base, AWS_REGION: undefined, FSS_METRIC_NAMESPACE: undefined }).metrics.namespace,
      ).toBeNull();
    });

    it('names the namespace in the startup line, which is how an operator checks where metrics went', () => {
      expect(describeWorkerConfig(readWorkerConfig(base))['metricNamespace']).toBe('FSS/fss-test');
    });
  });

  it('turns metric publication off when the environment says off', () => {
    expect(readWorkerConfig({ ...base, FSS_METRICS: 'off' }).metrics.mode).toBe('off');
    // Nothing is published when the region is unknown either: an alarm that never
    // fires is better discovered at startup than during an incident.
    expect(readWorkerConfig({ ...base, AWS_REGION: undefined }).metrics.region).toBeNull();
  });
});
