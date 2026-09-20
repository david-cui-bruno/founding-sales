import { describe, expect, it } from 'vitest';
import { CARRY_SUBCOMMANDS, REQUIRED_OPTIONS, cipherChoice, parseCarryCommand } from '../../tools/carry/cli.ts';

/**
 * The carry's argument surface (lane G11).
 *
 * `parseCarryCommand` is pure so the whole of it can be tested without a database, a
 * network, an `age` binary or a file — and so the one property that matters can be
 * asserted directly: every subcommand names the options it needs, and a missing one
 * is a refusal rather than an empty string that reaches AWS.
 */

describe('the carry command line', () => {
  it('refuses an empty argument list by naming the subcommands', () => {
    const parsed = parseCarryCommand([]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('subcommand_missing');
    expect(parsed.detail).toBe(CARRY_SUBCOMMANDS.join(', '));
  });

  it('refuses a subcommand it does not have', () => {
    const parsed = parseCarryCommand(['rollback']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('subcommand_unknown');
  });

  it('has no subcommand that writes to the old table', () => {
    expect([...CARRY_SUBCOMMANDS].sort()).toEqual(['export', 'import', 'shred', 'verify']);
  });

  it('names every option each subcommand requires', () => {
    for (const subcommand of CARRY_SUBCOMMANDS) {
      const parsed = parseCarryCommand([subcommand]);
      expect(parsed.ok, subcommand).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason).toBe('option_missing');
      expect(REQUIRED_OPTIONS[subcommand]).toContain(parsed.detail);
    }
  });

  it('refuses a flag with no value rather than reading the next flag as one', () => {
    const parsed = parseCarryCommand(['verify', '--artifact', '--receipt', '/tmp/receipt.json']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('option_malformed');
  });

  it('accepts a complete verify invocation', () => {
    const parsed = parseCarryCommand([
      'verify',
      '--artifact',
      '/Volumes/carry/carry.fss-carry',
      '--receipt',
      '/Volumes/carry/carry.receipt.json',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.subcommand).toBe('verify');
    expect(parsed.value.options['artifact']).toBe('/Volumes/carry/carry.fss-carry');
  });

  it('takes the database connection by the *name* of an environment variable', () => {
    // Never the connection string itself: an argument list is visible in `ps` and
    // ends up in a shell history file.
    expect(REQUIRED_OPTIONS.import).toContain('database-url-env');
    expect(REQUIRED_OPTIONS.shred).toContain('database-url-env');
  });

  it('names no option that could hold a key or a connection string', () => {
    for (const options of Object.values(REQUIRED_OPTIONS)) {
      for (const forbidden of ['database-url', 'password', 'key', 'secret', 'token', 'local-key-file']) {
        expect(options).not.toContain(forbidden);
      }
    }
  });
});

describe('which key opens the artifact', () => {
  it('seals to a recipient and opens with an identity file', () => {
    const seal = cipherChoice({ recipient: 'age1notarealrecipient', identity: '/Volumes/carry/identity.txt' }, 'seal');
    expect(seal).toEqual({
      ok: true,
      kind: 'age',
      recipient: 'age1notarealrecipient',
      identityFile: '/Volumes/carry/identity.txt',
      command: 'age',
    });
    const open = cipherChoice({ identity: '/Volumes/carry/identity.txt' }, 'open');
    expect(open.ok && open.kind).toBe('age');
  });

  it('refuses to open without an identity rather than running age with an empty path', () => {
    const open = cipherChoice({ recipient: 'age1notarealrecipient' }, 'open');
    expect(open).toEqual({ ok: false, missing: 'identity' });
  });

  it('refuses to seal without a recipient', () => {
    expect(cipherChoice({ identity: '/Volumes/carry/identity.txt' }, 'seal')).toEqual({ ok: false, missing: 'recipient' });
  });

  it('lets a rehearsal name a key file instead, in both directions', () => {
    for (const direction of ['seal', 'open'] as const) {
      expect(cipherChoice({ 'local-key-file': '/tmp/rehearsal.key' }, direction)).toEqual({
        ok: true,
        kind: 'local',
        keyFile: '/tmp/rehearsal.key',
      });
    }
  });
});
