import { describe, expect, it } from 'vitest';
import { MAIL_EFFECT_KINDS } from '@fss/domain/mail';
import { mustCover, readRepositoryFile } from './support/coverage.ts';

/**
 * Appendix G 19: "A direct Gmail message to an automated opportunity switches it to
 * manual once."
 *
 * The mail lane imports a message the salesperson sent by hand, asserts the
 * opportunity moved from automated to manual, then re-imports the same message — a
 * duplicate push, a reconciliation pass — and asserts nothing happens a second time.
 * This check adds the mechanism behind "once": the effect is a row with a uniqueness
 * constraint and no way to rewrite it, which is what makes idempotence a property of
 * the schema rather than of the handler's care.
 *
 * ## The vacuous-pass trap
 *
 * An opportunity that was already manual cannot switch, so a fixture that neglected
 * to set `control_mode` would assert "still manual" twice and prove nothing at all.
 * The lane test closes it by asserting the mode was `automated` before the import and
 * by counting the `crm_domain_events` row afterwards. The residual trap is an effect
 * table that permits a second row for the same message and kind: the second import
 * would insert again, the count would be two, and somebody would "fix" the test
 * rather than the constraint. Closed here by asserting the constraint by name.
 */

describe('Appendix G 19: a direct send switches the opportunity to manual, once', () => {
  mustCover(19, [
    'Appendix G 19',
    'direct_send_manual',
    'directSendsSwitchedToManual',
    'applyDirectSendEffects',
  ]);

  it('gives the direct send an effect kind of its own', () => {
    // `opportunity_manual` is what a classified reply records; the direct send is a
    // different cause with the same consequence, and conflating them would lose the
    // reason the mode changed.
    expect(MAIL_EFFECT_KINDS).toContain('direct_send_manual');
    expect(MAIL_EFFECT_KINDS).toContain('opportunity_manual');
  });

  it('records the effect once and cannot rewrite it', () => {
    const migration = readRepositoryFile('packages/domain/db/migrations/0009_mail.sql');
    // One row per message, kind and target. A replayed import conflicts rather than
    // switching a second time.
    expect(migration).toContain('CONSTRAINT mail_message_effects_one_per_target');
    expect(migration).toContain('UNIQUE (workspace_id, mail_message_id, effect_kind, target_key)');
    expect(migration).toContain("'direct_send_manual'");
    // And the row is not editable, so "once" cannot be undone by an UPDATE either.
    expect(migration).toContain('REVOKE UPDATE, TRUNCATE ON mail_message_effects FROM app_runtime, migration;');
  });
});
