import { describe, expect, it } from 'vitest';
import { classifyMigration } from '../../tools/upgrade/classify.ts';
import { repositoryPath } from './support/repository.ts';

/**
 * Migration 0162 (ADR0038) adds the paid-check ledger and re-adds two CHECKs under their own names. The release operator
 * only releases additive or touches-existing migrations, and a `DROP CONSTRAINT` the classifier cannot see re-added by
 * name is destructive: the first 0162 dropped the 0160 unique constraints and was refused (`migration_classification_refused`).
 * This exercises the release classifier against the migration the upgrade runner actually applies.
 */
describe('migration 0162 classification', () => {
  it('is releasable: a new table and constraint swaps, never a destructive statement', () => {
    const result = classifyMigration(repositoryPath('packages/domain/db/migrations/0162_guessed_address_verification.sql'));
    expect(result.kind).toBe('touches-existing');
  });
});
