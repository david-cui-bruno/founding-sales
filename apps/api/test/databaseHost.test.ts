import { describe, expect, it } from 'vitest';
import { API_SCHEMA_RANGE } from '@fss/domain/db/schemaRange.ts';
import { readApiConfig } from '../src/bootstrap/config.ts';

/**
 * `FSS_DATABASE_HOST` on the API (lane W3-S8): Terraform's `active_database_host`, which
 * the restore runbook (`docs/greenfield/runbooks/restore.md`) points at a point-in-time
 * copy. The credential stays the secret's; only the endpoint moves. With the variable equal
 * to the secret's own host — production today — the connection is exactly what it was.
 */
describe('the API database connection', () => {
  const environment = {
    FSS_SCHEMA_MIN: String(API_SCHEMA_RANGE.minimum),
    FSS_SCHEMA_MAX: String(API_SCHEMA_RANGE.maximum),
    DATABASE_SECRET_ARN: JSON.stringify({
      username: 'app',
      password: 'pw',
      host: 'fss-prod-pg.example.invalid',
      port: 5432,
      dbname: 'fss',
    }),
  };

  it('uses the secret’s host when FSS_DATABASE_HOST is absent or the same', () => {
    expect(readApiConfig(environment).database.connectionString).toBe('postgresql://app:pw@fss-prod-pg.example.invalid:5432/fss');
    expect(readApiConfig({ ...environment, FSS_DATABASE_HOST: 'fss-prod-pg.example.invalid' }).database.connectionString).toBe(
      'postgresql://app:pw@fss-prod-pg.example.invalid:5432/fss',
    );
  });

  it('connects to FSS_DATABASE_HOST when it names another instance', () => {
    expect(readApiConfig({ ...environment, FSS_DATABASE_HOST: 'fss-prod-pg-r1.example.invalid' }).database.connectionString).toBe(
      'postgresql://app:pw@fss-prod-pg-r1.example.invalid:5432/fss',
    );
  });

  it('uses a whole DATABASE_URL as given', () => {
    expect(
      readApiConfig({ ...environment, DATABASE_URL: 'postgresql://u@local.test/db', FSS_DATABASE_HOST: 'elsewhere.test' }).database
        .connectionString,
    ).toBe('postgresql://u@local.test/db');
  });
});
