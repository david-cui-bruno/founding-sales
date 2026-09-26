import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FSS_COMMANDS,
  describeCommands,
  drillInvocations,
  parseFssCommand,
} from '../src/tools/fss/commands.ts';
import { MIGRATION_IDENTITY_COMMANDS } from '../src/tools/fss.ts';

/**
 * The operations command line's argument surface (lane G12g; rewired by G12h; the drill
 * deleted by W3-S8).
 *
 * The shell scripts are the callers that matter, and they called a tool this
 * repository did not have. This suite is the contract in both directions — the parser
 * accepts what they send, and nothing else.
 *
 * ## What W3-S8 changed
 *
 * The restore drill and its evidence seeder are deleted with `fss drill`,
 * `fss admin counts` and `fss admin drill seed-evidence`; the restore is a runbook
 * (`docs/greenfield/runbooks/restore.md`), whose commands are spelled out at the end of
 * this file. Every script that still invokes the tool is read, because a floor drawn
 * from one of them would go quiet the moment another grew a command.
 *
 * ## The vacuous-pass trap, named
 *
 * A test that asserted "the parser accepts `fss migrate`" would pass
 * against a parser that accepts everything, which is the one behaviour that makes a
 * misspelt flag in a script silently do nothing at three in the morning. So the
 * scripts' own text is the input — extracted rather than retyped, so a script that
 * adds a command fails here until the tool has it — and every case is paired with a
 * refusal: an unknown subcommand, an unknown flag, a value flag with no value, a
 * missing required flag.
 */

const CALLERS = [
  'infra/scripts/release-deploy.sh',
  // g39: the step between the deploy and the schema ranges. It is here for the same
  // reason the other two are — it names a command, and a script naming a command the
  // tool does not have is a step that fails inside a container nobody is watching.
  'infra/scripts/release-bootstrap-workspace.sh',
] as const;

const INVOCATIONS = CALLERS.flatMap(relative =>
  drillInvocations(readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8')),
);

describe('the fss command line accepts every invocation the release scripts make', () => {
  it('finds every `fss` invocation in the scripts', () => {
    // A floor on purpose: an extractor that silently found none would make every case
    // below vacuous, and the scripts are the specification here. Five is the number of
    // distinct commands the release actually issues — `migrate`,
    // `admin database-users ensure`, `verify`, `admin workspace bootstrap` since g39 and
    // `admin release-record put` since g71. The planned lines went with the drill script
    // (W3-S8); the calls left are real ones.
    expect(INVOCATIONS.length).toBeGreaterThanOrEqual(5);
    expect(INVOCATIONS.some(invocation => !invocation.planned)).toBe(true);

    // And the five are named, so a script that stopped calling one of them — which is
    // how "nothing migrates the database" happened in the first place — fails here.
    // The words before the first flag: `['admin','workspace','bootstrap','--slug','…']`
    // is `admin workspace bootstrap`. A flag's *value* is not part of the command's name.
    const commands = INVOCATIONS.map(invocation => {
      const flagAt = invocation.argv.findIndex(word => word.startsWith('--'));
      return (flagAt < 0 ? invocation.argv : invocation.argv.slice(0, flagAt)).join(' ');
    });
    for (const expected of [
      'migrate',
      'admin database-users ensure',
      'verify',
      'admin workspace bootstrap',
      // g71: release-deploy.sh --release-record stores the record the admin attests to.
      'admin release-record put',
    ]) {
      expect(commands, `no release script invokes \`fss ${expected}\``).toContain(expected);
    }
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
      expect(parsed, `a release script calls ${invocation.text} and the tool refused it`).toMatchObject({ ok: true });
    },
  );

  it('refuses what no caller sends', () => {
    expect(parseFssCommand([])).toMatchObject({ ok: false, reason: 'command_missing' });
    expect(parseFssCommand(['admin', 'holds', 'burn'])).toMatchObject({ ok: false, reason: 'command_unknown' });
    expect(parseFssCommand(['admin', 'holds', 'list', '--resaon', 'x'])).toMatchObject({ ok: false, reason: 'flag_unknown' });
    expect(parseFssCommand(['admin', 'suppression-journal', 'replay', '--from'])).toMatchObject({
      ok: false,
      reason: 'flag_value_missing',
    });
    // There is no --all-mailboxes (lane W3-S8 review): the copy's own mailboxes can miss one.
    expect(parseFssCommand(['admin', 'mailbox', 'reconcile-sent', '--since', '2026-09-20T00:00:00Z', '--all-mailboxes'])).toMatchObject({
      ok: false,
      reason: 'flag_unknown',
    });
    expect(parseFssCommand(['admin', 'mailbox', 'reconcile-sent', '--since', '2026-09-20T00:00:00Z'])).toMatchObject({
      ok: false,
      reason: 'flag_missing',
      detail: '--inventory',
    });
    expect(parseFssCommand(['admin', 'holds', 'release-restore', '--note', 'checked'])).toMatchObject({
      ok: false,
      reason: 'flag_missing',
      detail: '--admin-user',
    });
  });

  it('no longer has the restore drill or the nine-step protocol (lane W3-S8)', () => {
    for (const argv of [
      ['drill', '--reports', '/tmp/x', '--as-of', '2026-09-20T00:00:00Z'],
      ['admin', 'counts'],
      ['admin', 'restore-holds', 'open', '--expected-generation', '2'],
      ['admin', 'system-generation', 'advance', '--report', '/tmp/x'],
      ['admin', 'restore-report', '--out', '/tmp/x'],
      ['admin', 'drill', 'seed-evidence', '--workspace-slug', 'x', '--phase', 'before'],
      ['admin', 'mailbox', 'recover', '--since', '2026-09-20T00:00:00Z', '--all-mailboxes'],
      ['admin', 'mailbox', 'watch-renew', '--all-mailboxes'],
      ['admin', 'jobs', 'discard-runnable'],
      ['admin', 'scheduler', 'run-once'],
      ['admin', 'dial-authorize', '--any'],
    ]) {
      expect(parseFssCommand(argv), argv.join(' ')).toMatchObject({ ok: false, reason: 'command_unknown' });
    }
  });

  it('describes every command it has, so `fss` with no arguments is usable', () => {
    const described = describeCommands();
    for (const command of FSS_COMMANDS) expect(described).toContain(command.path.join(' '));
  });
});

describe('the commands release-deploy.sh runs on the migration task definition', () => {
  // That task definition injects MIGRATION_DATABASE_SECRET and FSS_RUNTIME_DATABASE_SECRET_ARN
  // and no DATABASE_SECRET_ARN (infra/modules/cluster/tests/migration_identity.tftest.hcl).
  // A command run there that the tool does not list as a migration-identity command is
  // refused before it looks at the database: fss migrate on 23 September 2026 (twice),
  // then fss admin database-users ensure (run 35883201716). The script is the input.
  const script = readFileSync(
    fileURLToPath(new URL('../../../infra/scripts/release-deploy.sh', import.meta.url)),
    'utf8',
  ).replaceAll('\\\n', ' ');
  const onMigrationTask = [...script.matchAll(/one_off\s+\S+\s+"\$MIGRATION_TASK_DEFINITION"\s+migration\s+(.+)$/gmu)]
    .map(match => (match[1] ?? '').split(/\s+/u).filter(word => word.length > 0))
    .map(argv => {
      const firstOption = argv.findIndex(word => word.startsWith('--'));
      return (firstOption === -1 ? argv : argv.slice(0, firstOption)).join(' ');
    });

  it('the script runs at least migrate and database-users there, and each is a migration-identity command', () => {
    expect(onMigrationTask).toContain('migrate');
    expect(onMigrationTask).toContain('admin database-users ensure');
    for (const command of onMigrationTask) {
      expect(MIGRATION_IDENTITY_COMMANDS, `${command} runs on the migration task definition`).toContain(command);
    }
  });

  it('every migration-identity command is one the parser knows, so the list holds no phantom', () => {
    for (const command of MIGRATION_IDENTITY_COMMANDS) {
      expect(parseFssCommand(command.split(' ')).ok, command).toBe(true);
    }
  });
});

/**
 * The restore runbook's commands (lane W3-S8), read from the runbook itself.
 *
 * They are the ones an operator types under the most pressure, so the runbook's text is
 * the input, not a copy of it: every `fss_task <step> <kind> [options] -- <words>` in
 * `docs/greenfield/runbooks/restore.md` is extracted and parsed, and a runbook that
 * misspells a flag, or stops running one of the named commands, fails here.
 */
function runbookCommands(): readonly string[][] {
  const text = readFileSync(fileURLToPath(new URL('../../../docs/greenfield/runbooks/restore.md', import.meta.url)), 'utf8')
    .replaceAll('\\\n', ' ');
  const found: string[][] = [];
  // One line can run several (`fss_task migrate ... && fss_task users ...`), so each
  // `fss_task` starts its own segment.
  const segments = text.split('\n').flatMap(line => line.split('fss_task ').slice(1));
  for (const segment of segments) {
    const match = /^\S+\s+(?:migration|operations)\b.*?\s--\s(.+)$/u.exec(segment);
    if (match === null) continue;
    let tail = match[1] ?? '';
    for (const boundary of [' && ', ' ; ', '; ', ' | ', ' >', ' #', '`']) {
      const at = tail.indexOf(boundary);
      if (at >= 0) tail = tail.slice(0, at);
    }
    found.push(
      tail
        .split(/\s+/u)
        .filter(word => word.length > 0)
        .map(word => word.replaceAll('"', ''))
        .map(word => (word.includes('$') || word.startsWith('<') ? 'placeholder-value' : word)),
    );
  }
  return found;
}

describe('the restore runbook’s commands (lane W3-S8)', () => {
  const commands = runbookCommands();

  it('finds the runbook’s commands, and each one it must run', () => {
    const names = commands.map(argv => {
      const flagAt = argv.findIndex(word => word.startsWith('--'));
      return (flagAt < 0 ? argv : argv.slice(0, flagAt)).join(' ');
    });
    for (const expected of [
      'admin mailbox list',
      'migrate',
      'admin database-users ensure',
      'schema-version',
      'admin suppression-journal replay',
      'admin mailbox reconcile-sent',
      'admin holds list',
      'admin holds release-restore',
    ]) {
      expect(names, `the runbook no longer runs fss ${expected}`).toContain(expected);
    }
  });

  it.each(commands.map(argv => [argv.join(' '), argv] as const))('parses %s', (_text, argv) => {
    expect(parseFssCommand(argv)).toMatchObject({ ok: true });
  });

  it('runs the reconciliation only with an inventory', () => {
    const reconciles = commands.filter(argv => argv.join(' ').startsWith('admin mailbox reconcile-sent'));
    expect(reconciles.length).toBeGreaterThanOrEqual(2);
    for (const argv of reconciles) expect(argv).toContain('--inventory');
  });
});
