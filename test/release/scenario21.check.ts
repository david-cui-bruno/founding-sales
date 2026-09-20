import { describe, expect, it } from 'vitest';
import { SUPPRESSION_REFUSAL_CODES } from '@fss/contracts';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 21: "Suppression update, delete, cross-key supersession and an
 * unsupported canonicalizer change are refused."
 *
 * The policy suite proves all four against a real cluster: the application role gets
 * `42501` on an UPDATE and a DELETE, the supersession trigger raises
 * `suppression_events_supersession_same_key` on a row that names another canonical
 * key, and a correction against an event written by an unknown canonicalizer comes
 * back `canonicalizer_unsupported`. This check adds the privilege grant itself,
 * which lives in migration 0001 and is therefore invisible to the suite that only
 * observes its effect.
 *
 * ## The vacuous-pass trap
 *
 * Refusing because the row did not exist is not refusing the operation: an UPDATE
 * matching nothing affects zero rows and raises nothing, so a suite that targeted an
 * absent event would see "no change" and call it a refusal. The lane test closes it
 * by targeting a row it has just inserted and by asserting the *privilege* error code
 * rather than a row count. The trap here is a later migration granting the privilege
 * back — perfectly plausible while adding a column — which no behavioural test in the
 * lane would notice until something rewrote history.
 */

describe('Appendix G 21: suppression events are insert-only by privilege', () => {
  mustCover(21, [
    'scenario 21',
    'suppression_events_supersession_same_key',
    'canonicalizer_unsupported',
    '42501',
  ]);

  it('revokes UPDATE and DELETE on the ledger and never grants them back', () => {
    const foundation = readRepositoryFile('packages/domain/db/migrations/0001_foundation.sql');
    expect(foundation).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON suppression_events FROM app_runtime, migration;');
    // Insert and select are the whole surface. A later migration adding an UPDATE
    // grant would make every behavioural assertion in the lane suite start passing
    // for the wrong reason.
    for (const file of [
      'packages/domain/db/migrations/0006_policy.sql',
      'packages/domain/db/migrations/0009_mail.sql',
    ]) {
      const migration = readRepositoryFile(file);
      expect(migration, `${file} grants UPDATE back`).not.toContain('GRANT UPDATE ON suppression_events');
      expect(migration, `${file} grants DELETE back`).not.toContain('GRANT DELETE ON suppression_events');
    }
    // The finalization ledger is the same shape, for the same reason: the winner of
    // the correction race is a fact about what happened.
    const policy = readRepositoryFile('packages/domain/db/migrations/0006_policy.sql');
    expect(policy).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON suppression_finalizations FROM app_runtime, migration;',
    );
  });

  it('names the canonicalizer refusal separately from the supersession refusals', () => {
    // Four causes, and the third and fourth must not be answerable with the same
    // word, or an operator reading a refusal cannot tell whether the event or the
    // build is the thing that is out of date.
    for (const code of ['canonicalizer_unsupported', 'already_superseded', 'handle_uncanonical'] as const) {
      expect(SUPPRESSION_REFUSAL_CODES).toContain(code);
    }
    expect(new Set(SUPPRESSION_REFUSAL_CODES).size).toBe(SUPPRESSION_REFUSAL_CODES.length);
  });
});
