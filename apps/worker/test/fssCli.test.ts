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
 * The operations command line's argument surface (lane G12g; rewired by G12h).
 *
 * The shell scripts are the callers that matter, and they called a tool this
 * repository did not have. This suite is the contract in both directions — the parser
 * accepts what they send, and nothing else.
 *
 * ## What changed in G12h, and what did not
 *
 * The drill used to make fourteen `fss admin` calls from the runner. It cannot: the
 * rehearsal database is private and a GitHub runner has no route to it. So the
 * database work is now two one-off ECS tasks — `fss admin counts` for the baseline and
 * `fss drill` for steps 1 to 9 — and `infra/scripts/release-deploy.sh` makes three
 * more (`migrate`, `admin database-users ensure`, `verify`). The fourteen admin
 * commands still run; they run *inside* `fss drill`, which calls them as functions, so
 * `apps/worker/test/fssSurface.test.ts` is where their behaviour is asserted and this
 * is where their spelling on a command line is.
 *
 * Both scripts are read, because both now invoke the tool and a floor drawn from one
 * of them would go quiet the moment the other grew a command.
 *
 * ## The vacuous-pass trap, named
 *
 * A test that asserted "the parser accepts `fss admin counts --as-of X`" would pass
 * against a parser that accepts everything, which is the one behaviour that makes a
 * misspelt flag in a script silently do nothing at three in the morning. So the
 * scripts' own text is the input — extracted rather than retyped, so a script that
 * adds a command fails here until the tool has it — and every case is paired with a
 * refusal: an unknown subcommand, an unknown flag, a value flag with no value, a
 * missing required flag.
 */

const CALLERS = [
  'infra/scripts/rehearsal-restore-drill.sh',
  'infra/scripts/release-deploy.sh',
  // g39: the step between the deploy and the schema ranges. It is here for the same
  // reason the other two are — it names a command, and a script naming a command the
  // tool does not have is a step that fails inside a container nobody is watching.
  'infra/scripts/release-bootstrap-workspace.sh',
  // g40: the step that writes the activity the drill reconstructs. Same reason again —
  // a script naming a command the tool does not have is a one-off task that fails
  // inside a container nobody is watching, minutes after the runner moved on.
  'infra/scripts/release-seed-drill-evidence.sh',
] as const;

const INVOCATIONS = CALLERS.flatMap(relative =>
  drillInvocations(readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8')),
);

describe('the fss command line accepts every invocation the release scripts make', () => {
  it('finds every `fss` invocation in both scripts, planned and real', () => {
    // A floor on purpose: an extractor that silently found none would make every case
    // below vacuous, and the scripts are the specification here. Eight is the number of
    // distinct commands the release actually issues — `admin counts`, `drill`,
    // `migrate`, `admin database-users ensure`, `verify`, `admin workspace bootstrap`
    // since g39, `admin drill seed-evidence` since g40 and `admin release-record put`
    // since g71 — and each appears at least once in a planned line and once in a real
    // one.
    expect(INVOCATIONS.length).toBeGreaterThanOrEqual(8);
    expect(INVOCATIONS.some(invocation => invocation.planned)).toBe(true);
    expect(INVOCATIONS.some(invocation => !invocation.planned)).toBe(true);

    // And the seven are named, so a script that stopped calling one of them — which is
    // how "nothing migrates the database" happened in the first place — fails here.
    // The words before the first flag: `['admin','counts','--as-of','…']` is
    // `admin counts`. A flag's *value* is not part of the command's name.
    const commands = INVOCATIONS.map(invocation => {
      const flagAt = invocation.argv.findIndex(word => word.startsWith('--'));
      return (flagAt < 0 ? invocation.argv : invocation.argv.slice(0, flagAt)).join(' ');
    });
    for (const expected of [
      'admin counts',
      'drill',
      'migrate',
      'admin database-users ensure',
      'verify',
      'admin workspace bootstrap',
      'admin drill seed-evidence',
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
 * Lane g53: where the drill's step 0 comes from, and the launch that decides it.
 *
 * The thirteenth full run (24 September 2026) launched `fss drill --as-of <restore
 * target>` against the restored instance, so the drill measured its baseline again on
 * the restored copy while the baseline measured on the source sat in the runner's
 * reports. The drill now takes the source baseline as a value, `--baseline-json`.
 *
 * ## The vacuous-pass trap
 *
 * The drill script's real launches go through `drill_task` and never spell `fss`, so
 * an extractor that read only `fss …` lines saw the planned line and nothing else: the
 * plan could say `--baseline-json` while the real launch still passed `--as-of`. So the
 * extractor reads the launcher too, and the real launch is asserted here, not the plan.
 */
describe('fss drill takes its baseline from exactly one place (lane g53)', () => {
  const reports = ['--reports', '/tmp/fss-drill'];
  const handed = '{"asOf":"2026-09-21T00:00:00Z","sends":1,"replies":1,"suppressions":1,"crm_edits":1,"migrations":1}';

  it('accepts the baseline handed over as a value, braces and quotes included', () => {
    const parsed = parseFssCommand(['drill', ...reports, '--baseline-json', handed, '--all-mailboxes']);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.options['--baseline-json']).toBe(handed);
  });

  it('refuses any two of --baseline, --as-of and --baseline-json, and none of them', () => {
    for (const pair of [
      ['--as-of', '2026-09-21T00:00:00Z', '--baseline-json', handed],
      ['--baseline', '/tmp/before.json', '--baseline-json', handed],
      ['--baseline', '/tmp/before.json', '--as-of', '2026-09-21T00:00:00Z'],
    ]) {
      expect(parseFssCommand(['drill', ...reports, ...pair]), pair.join(' ')).toMatchObject({
        ok: false,
        reason: 'selection_missing',
      });
    }
    expect(parseFssCommand(['drill', ...reports])).toMatchObject({ ok: false, reason: 'selection_missing' });
    expect(parseFssCommand(['drill', ...reports, '--baseline-json'])).toMatchObject({
      ok: false,
      reason: 'flag_value_missing',
    });
  });

  it('reads the drill script’s real launches, not only its plan', () => {
    const drill = drillInvocations(
      readFileSync(fileURLToPath(new URL('../../../infra/scripts/rehearsal-restore-drill.sh', import.meta.url)), 'utf8'),
    );
    const real = drill.filter(invocation => !invocation.planned).map(invocation => invocation.argv.slice(0, 2).join(' '));
    expect(real, 'the baseline task on the source is launched through drill_task').toContain('admin counts');
    expect(real, 'and so is the drill against the restored instance').toContain('drill --reports');
  });

  it('launches the drill with the source baseline, never an instant to measure the restored copy at', () => {
    const launches = drillInvocations(
      readFileSync(fileURLToPath(new URL('../../../infra/scripts/rehearsal-restore-drill.sh', import.meta.url)), 'utf8'),
    ).filter(invocation => invocation.argv[0] === 'drill');
    expect(launches.filter(invocation => !invocation.planned).length).toBeGreaterThanOrEqual(1);
    for (const launch of launches) {
      expect(launch.argv, launch.text).toContain('--baseline-json');
      expect(launch.argv, launch.text).not.toContain('--as-of');
      expect(launch.argv, launch.text).not.toContain('--baseline');
    }
  });
});
