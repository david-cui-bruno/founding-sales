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
  // P7: the deploy and, since g39, the bootstrap of the first workspace (deploy.sh bootstrap).
  'infra/scripts/deploy.sh',
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
      detail: '--inventory-host',
    });
    expect(
      parseFssCommand(['admin', 'mailbox', 'reconcile-sent', '--since', '2026-09-20T00:00:00Z', '--restore-point', '2026-09-20T00:10:00Z', '--inventory-host', 'old.example.test']),
    ).toMatchObject({ ok: false, reason: 'flag_missing', detail: '--inventory-marker' });
    expect(parseFssCommand(['admin', 'restore-marker', 'put'])).toMatchObject({ ok: false, reason: 'flag_missing', detail: '--marker' });
    expect(parseFssCommand(['admin', 'restore-marker', 'put', '--marker', 'x'])).toMatchObject({ ok: false, reason: 'flag_missing', detail: '--restore-point' });
    // Lane W3-S8 second review: no typed inventory, and no caller-named admin.
    expect(
      parseFssCommand(['admin', 'mailbox', 'reconcile-sent', '--since', '2026-09-20T00:00:00Z', '--inventory', 'a@example.test']),
    ).toMatchObject({ ok: false, reason: 'flag_unknown' });
    expect(parseFssCommand(['admin', 'holds', 'release-restore', '--admin-user', 'someone', '--note', 'checked'])).toMatchObject({
      ok: false,
      reason: 'flag_unknown',
    });
    expect(parseFssCommand(['admin', 'holds', 'release-restore'])).toMatchObject({
      ok: false,
      reason: 'flag_missing',
      detail: '--note',
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
    fileURLToPath(new URL('../../../infra/scripts/deploy.sh', import.meta.url)),
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
 * the input, not a copy of it. Every `bash` fence of `docs/greenfield/runbooks/restore.md`
 * is extracted with its line numbers (a continued line joined to the next), and every
 * `fss_task` in one must be a call the extractor can read —
 * `fss_task <step> <migration|operations> [--capture F] [--env NAME=VALUE]... -- <words>` —
 * so a misspelt task kind or a missing `--` fails here rather than dropping out of the
 * check (the second W3-S8 review). Then each call's words are parsed as `fss` parses them.
 * A command named only in prose does not count.
 */
interface RunbookCall {
  readonly line: number;
  readonly argv: readonly string[];
}

interface RunbookScan {
  readonly fences: number;
  readonly calls: readonly RunbookCall[];
  readonly unreadable: readonly { readonly line: number; readonly text: string }[];
}

/** Shell words, quotes removed; a word naming a variable or a `<placeholder>` becomes a value. */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let started = false;
  for (const character of text) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started || word.length > 0) words.push(word);
      word = '';
      started = false;
    } else {
      word += character;
    }
  }
  if (started || word.length > 0) words.push(word);
  return words.map(value => (value.includes('$') || value.startsWith('<') ? 'placeholder-value' : value));
}

function scanRunbook(markdown: string): RunbookScan {
  const lines = markdown.split('\n');
  const logical: { line: number; text: string }[] = [];
  let fences = 0;
  let inBash = false;
  let inOther = false;
  let pending: { line: number; text: string } | null = null;
  lines.forEach((raw, index) => {
    const number = index + 1;
    if (!inBash && !inOther && /^```/u.test(raw)) {
      if (/^```bash\s*$/u.test(raw)) {
        inBash = true;
        fences += 1;
      } else {
        inOther = true;
      }
      return;
    }
    if ((inBash || inOther) && /^```\s*$/u.test(raw)) {
      inBash = false;
      inOther = false;
      if (pending !== null) logical.push(pending);
      pending = null;
      return;
    }
    if (!inBash) return;
    const joined: { line: number; text: string } = pending === null ? { line: number, text: raw } : { line: pending.line, text: `${pending.text} ${raw.trim()}` };
    if (joined.text.endsWith('\\')) {
      pending = { line: joined.line, text: joined.text.slice(0, -1) };
    } else {
      logical.push(joined);
      pending = null;
    }
  });

  const calls: RunbookCall[] = [];
  const unreadable: { line: number; text: string }[] = [];
  const call = /^(\S+)\s+(migration|operations)((?:\s+--(?:capture|env)\s+\S+)*)\s+--\s+(.+)$/u;
  for (const { line, text } of logical) {
    // The helper's own definition is not a call.
    if (/^fss_task\(\)/u.test(text.trim())) continue;
    // The command word itself, followed by a space or by nothing: a bare `fss_task` at the
    // end of a line is a call with no arguments, and is reported rather than skipped.
    const starts = [...text.matchAll(/(?:^|[\s;&|({!])fss_task(?=\s|$)/gu)].map(match => (match.index ?? 0) + match[0].length);
    for (const start of starts) {
      const segment = text.slice(start).trimStart();
      const parsed = call.exec(segment);
      if (parsed === null) {
        unreadable.push({ line, text: `fss_task ${segment}` });
        continue;
      }
      let tail = parsed[4] ?? '';
      for (const boundary of [' && ', ' || ', ' ; ', '; ', ' | ', ' >', ' #', '`']) {
        const at = tail.indexOf(boundary);
        if (at >= 0) tail = tail.slice(0, at);
      }
      calls.push({ line, argv: shellWords(tail) });
    }
  }
  return { fences, calls, unreadable };
}

const runbook = scanRunbook(
  readFileSync(fileURLToPath(new URL('../../../docs/greenfield/runbooks/restore.md', import.meta.url)), 'utf8'),
);

describe('the restore runbook’s commands (lane W3-S8)', () => {
  const commands = runbook.calls.map(found => found.argv);
  const nameOf = (argv: readonly string[]): string => {
    const flagAt = argv.findIndex(word => word.startsWith('--'));
    return (flagAt < 0 ? argv : argv.slice(0, flagAt)).join(' ');
  };

  it('reads every fss_task in a bash fence as a call, and cannot drop a malformed one', () => {
    expect(runbook.fences).toBeGreaterThan(5);
    expect(runbook.unreadable, 'fss_task lines the extractor could not read').toEqual([]);
    // The extractor itself: a misspelt kind, a missing separator, and an unknown option are
    // each reported, with their lines, never skipped; prose and other fences are not read.
    const probe = scanRunbook(
      [
        'prose: fss_task x operatons -- schema-version',
        '```bash',
        'fss_task a operatons -- schema-version',
        'need && fss_task b operations schema-version',
        'fss_task c operations --report x -- schema-version',
        'need && fss_task',
        'fss_task d operations \\',
        '  --capture "$W/d.log" -- admin holds list --reason restore_in_progress && report d',
        '```',
        '```text',
        'fss_task e nowhere',
        '```',
      ].join('\n'),
    );
    expect(probe.unreadable.map(found => found.line)).toEqual([3, 4, 5, 6]);
    expect(probe.calls).toEqual([{ line: 7, argv: ['admin', 'holds', 'list', '--reason', 'restore_in_progress'] }]);
  });

  it('finds, in its bash fences, each command it must run', () => {
    const names = commands.map(nameOf);
    for (const expected of [
      'migrate',
      'admin database-users ensure',
      'schema-version',
      'admin suppression-journal replay',
      'admin mailbox reconcile-sent',
      'admin restore-marker put',
      'admin holds list',
      'admin holds release-restore',
    ]) {
      expect(names, `the runbook no longer runs fss ${expected} in a bash fence`).toContain(expected);
    }
  });

  it.each(runbook.calls.map(found => [`line ${String(found.line)}: ${found.argv.join(' ')}`, found.argv] as const))(
    'parses %s',
    (_text, argv) => {
      expect(parseFssCommand(argv)).toMatchObject({ ok: true });
    },
  );

  it('reads the inventory from the instance being replaced on every reconciliation, never from a typed list', () => {
    const reconciles = commands.filter(argv => nameOf(argv) === 'admin mailbox reconcile-sent');
    expect(reconciles.length).toBeGreaterThanOrEqual(2);
    for (const argv of reconciles) {
      expect(argv).toContain('--inventory-host');
      expect(argv).toContain('--inventory-marker');
      expect(argv).toContain('--inventory-instance');
      expect(argv).toContain('--restore-point');
      expect(argv).not.toContain('--inventory');
    }
  });

  it('releases an unattached-send hold only by id and with a resolution', () => {
    const releases = commands.filter(argv => nameOf(argv) === 'admin holds release-restore');
    expect(releases.some(argv => argv.includes('--hold') && argv.includes('--resolution'))).toBe(true);
    for (const argv of releases) expect(argv).not.toContain('--admin-user');
  });
});
