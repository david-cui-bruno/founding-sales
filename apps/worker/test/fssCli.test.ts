import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FSS_COMMANDS,
  describeCommands,
  drillInvocations,
  parseFssCommand,
} from '../src/tools/fss/commands.ts';

/**
 * The operations command line's argument surface (lane G12g).
 *
 * `infra/scripts/rehearsal-restore-drill.sh` is the only caller that matters, and it
 * calls a tool that did not exist: fourteen `fss admin` invocations, two output
 * conventions (JSON on stdout, a bare integer for `--count`) and a report file. This
 * suite is the contract in both directions — the parser accepts what the drill sends,
 * and nothing else.
 *
 * ## The vacuous-pass trap, named
 *
 * A test that asserted "the parser accepts `fss admin counts --as-of X`" would pass
 * against a parser that accepts everything, which is the one behaviour that makes a
 * misspelt flag in the drill silently do nothing at three in the morning. So the
 * drill's own text is the input — extracted from the script rather than retyped, so a
 * drill that adds a command fails here until the tool has it — and every case is
 * paired with a refusal: an unknown subcommand, an unknown flag, a value flag with no
 * value, a missing required flag.
 */

const DRILL = fileURLToPath(new URL('../../../infra/scripts/rehearsal-restore-drill.sh', import.meta.url));

const SCRIPT = readFileSync(DRILL, 'utf8');
const INVOCATIONS = drillInvocations(SCRIPT);

describe('the fss command line accepts every invocation the restore drill makes', () => {
  it('finds every `fss` invocation in the drill, planned and real', () => {
    // A floor on purpose: an extractor that silently found none would make every case
    // below vacuous, and the drill is the specification here.
    expect(INVOCATIONS.length).toBeGreaterThanOrEqual(14);
    expect(INVOCATIONS.some(invocation => invocation.planned)).toBe(true);
    expect(INVOCATIONS.some(invocation => !invocation.planned)).toBe(true);
  });

  it.each(INVOCATIONS.map(invocation => [invocation.text, invocation] as const))(
    'accepts %s',
    (_text, invocation) => {
      const parsed = parseFssCommand(invocation.argv);
      // A planned line carries prose after the command ("-> expect refused") and is
      // checked for its command name and flag *names* only; a real one is checked whole.
      if (invocation.planned && !parsed.ok) {
        expect(parsed.reason, invocation.text).toBe('flag_missing');
        return;
      }
      expect(parsed, `the drill calls ${invocation.text} and the tool refused it`).toMatchObject({ ok: true });
    },
  );

  it('refuses what the drill never sends', () => {
    expect(parseFssCommand([])).toMatchObject({ ok: false, reason: 'command_missing' });
    expect(parseFssCommand(['admin', 'holds', 'burn'])).toMatchObject({ ok: false, reason: 'command_unknown' });
    expect(parseFssCommand(['admin', 'counts', '--asof', 'x'])).toMatchObject({ ok: false, reason: 'flag_unknown' });
    expect(parseFssCommand(['admin', 'counts', '--as-of'])).toMatchObject({
      ok: false,
      reason: 'flag_value_missing',
    });
    expect(parseFssCommand(['admin', 'mailbox', 'recover', '--all-mailboxes'])).toMatchObject({
      ok: false,
      reason: 'flag_missing',
    });
    expect(parseFssCommand(['admin', 'mailbox', 'recover', '--since', '2026-09-20T00:00:00Z'])).toMatchObject({
      ok: false,
      reason: 'selection_missing',
    });
  });

  it('describes every command it has, so `fss` with no arguments is usable', () => {
    const described = describeCommands();
    for (const command of FSS_COMMANDS) expect(described).toContain(command.path.join(' '));
  });
});
