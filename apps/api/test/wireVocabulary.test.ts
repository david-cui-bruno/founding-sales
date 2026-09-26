import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as wire from '@fss/contracts';
import { type ResumeDecision } from '@fss/domain/src/rules/holds.ts';

/**
 * The two wire vocabularies the domain does not import from `@fss/contracts`, held to
 * what defines them: the resume decisions to `decideResume`'s answer type, and the
 * confirmation consequences to the CHECK constraint in migration 0011. Every other
 * closed vocabulary is declared once, in `@fss/contracts`, and the domain imports it.
 */

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('the wire vocabularies the domain does not import', () => {
  it('RESUME_DECISION_KINDS is decideResume’s answers and the deprecated review_required', () => {
    const same: Same<Exclude<(typeof wire.RESUME_DECISION_KINDS)[number], 'review_required'>, ResumeDecision['kind']> = true;
    expect(same).toBe(true);
    expect(new Set(wire.RESUME_DECISION_KINDS).size).toBe(wire.RESUME_DECISION_KINDS.length);
  });

  it('REPLY_CONFIRMATION_CONSEQUENCES is migration 0011’s CHECK', () => {
    const migration = readFileSync(
      new URL('../../../packages/domain/db/migrations/0011_classification.sql', import.meta.url),
      'utf8',
    );
    const check = /mail_reply_confirmations_consequences_known\s+CHECK \(consequences <@ ARRAY\[([^\]]+)\]/u.exec(migration);
    expect(check).not.toBeNull();
    const values = [...(check?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map(match => match[1]);
    expect([...wire.REPLY_CONFIRMATION_CONSEQUENCES]).toEqual(values);
  });
});
