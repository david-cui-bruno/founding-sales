import { describe, expect, it } from 'vitest';

import { appHealthSchema } from '../../src/shared/healthContract';

const validHealth = {
  appVersion: '1.0.0',
  schemaVersion: 1,
  databasePath: '/Users/founder/Library/Application Support/Callie/callie.sqlite3',
  fts5Available: true,
  pendingJobs: 2,
  interruptedJobsRecovered: 1,
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
  ] as const;

  for (const [description, value] of malformedValues) {
    it(`rejects a response with ${description}`, () => {
      expect(() => appHealthSchema.parse(value)).toThrow();
    });
  }
});
