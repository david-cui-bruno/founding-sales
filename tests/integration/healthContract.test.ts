import { describe, expect, it } from 'vitest';

import { appHealthSchema, type AppHealth } from '../../src/shared/healthContract';

const validHealth: AppHealth = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/Users/founder/Library/Application Support/Callie/callie.sqlite3',
  databaseEncrypted: true,
  cipherVersion: 'SQLite3 Multiple Ciphers 2.3.5',
  fts5Available: true,
  pendingJobs: 2,
  interruptedJobsRecovered: 1,
  domainStatus: 'ready',
  domainReady: true,
  domainBlockingViolationCount: 0,
  domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0,
  pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
};

describe('appHealthSchema', () => {
  it('accepts the complete foundation health response', () => {
    expect(appHealthSchema.parse(validHealth)).toEqual(validHealth);
  });

  const malformedValues = [
    ['empty app version', { ...validHealth, appVersion: '' }],
    ['zero schema version', { ...validHealth, schemaVersion: 0 }],
    ['fractional schema version', { ...validHealth, schemaVersion: 1.5 }],
    ['empty database path', { ...validHealth, databasePath: '' }],
    ['non-boolean FTS5 result', { ...validHealth, fts5Available: 'yes' }],
    ['negative pending jobs', { ...validHealth, pendingJobs: -1 }],
    ['fractional recovery count', { ...validHealth, interruptedJobsRecovered: 0.5 }],
    ['removed operational status overlay', { ...validHealth, operationalStatus: 'ready' }],
    ['removed sourcing overlay', { ...validHealth, sourcing: { status: 'healthy' } }],
  ] as const;

  for (const [description, value] of malformedValues) {
    it(`rejects a response with ${description}`, () => {
      expect(() => appHealthSchema.parse(value)).toThrow();
    });
  }
});
