import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as wire from '@fss/contracts';

/**
 * The one wire vocabulary the domain does not import from `@fss/contracts`, held to
 * what defines it: the confirmation consequences to the CHECK constraint in migration
 * 0011. Every other closed vocabulary is declared once, in `@fss/contracts`, and the
 * domain imports it. (`RESUME_DECISION_KINDS` was the other, and went with the resume
 * review and migration 0021.)
 */

describe('the wire vocabularies the domain does not import', () => {
  it('REPLY_CONFIRMATION_CONSEQUENCES is migration 0053’s CHECK', () => {
    const migration = readFileSync(
      new URL('../../../packages/domain/db/migrations/0053_outreach_scope.sql', import.meta.url),
      'utf8',
    );
    const check = /mail_reply_confirmations_consequences_known\s+CHECK\s*\(consequences <@ ARRAY\[([^\]]+)\]/u.exec(migration);
    expect(check).not.toBeNull();
    const values = [...(check?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map(match => match[1]);
    expect([...wire.REPLY_CONFIRMATION_CONSEQUENCES]).toEqual(values);
  });
});
