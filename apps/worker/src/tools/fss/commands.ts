/**
 * The `fss` command line's grammar, as data (lane G12g).
 *
 * `infra/scripts/rehearsal-restore-drill.sh` calls a tool this repository did not
 * have. The drill is the specification: every flag below is one the drill passes, in
 * the spelling it passes it, and `drillInvocations` extracts them from the script so
 * the two cannot drift. A flag nobody calls is not here.
 *
 * Parsing is separated from doing for the reason `apps/worker/tools/carry/cli.ts`
 * separated them: the whole argument surface is then testable without a database, a
 * cloud credential or a file, and an operator's typo is refused by name rather than
 * silently treated as a default.
 *
 * ## Two output conventions, because the drill parses both
 *
 * Most commands print one JSON object on stdout, and `--report <path>` writes the
 * same bytes to a file. `holds list --count` prints a bare integer, because the drill
 * does `held="$(fss admin holds list --reason restore_in_progress --count)"` and then
 * compares it with `-lt 1`. Printing JSON there would make the comparison a shell
 * error, so the convention is the caller's, not ours.
 */

export type FssFlag = string;

export interface FssCommandSpec {
  /** `['admin', 'mailbox', 'recover']`. The words before the first `--flag`. */
  readonly path: readonly string[];
  /** Flags that take the next argument as their value. */
  readonly valueFlags: readonly FssFlag[];
  /** Flags that are their own value. */
  readonly booleanFlags: readonly FssFlag[];
  /** Value flags without which the command refuses. */
  readonly requiredFlags: readonly FssFlag[];
  /**
   * A closed set of which exactly one must be present, or the command refuses with
   * `selection_missing`. `--all-mailboxes` versus `--mailbox <id>`: "every mailbox"
   * is a decision an operator makes out loud, never a default a tool reaches by
   * omission, and neither is a mailbox it guessed.
   */
  readonly oneOf?: readonly FssFlag[];
  readonly summary: string;
}

/** Every flag that names a path a report is written to. */
export const REPORT_FLAG = '--report';

const REPORTABLE = [REPORT_FLAG] as const;

export const FSS_COMMANDS: readonly FssCommandSpec[] = Object.freeze([
  {
    path: ['migrate'],
    valueFlags: [...REPORTABLE],
    booleanFlags: ['--allow-any-role'],
    requiredFlags: [],
    summary: 'apply every unapplied migration forward under the migration advisory lock',
  },
  {
    path: ['migrate', 'up'],
    valueFlags: [...REPORTABLE],
    booleanFlags: ['--allow-any-role'],
    requiredFlags: [],
    summary: 'the same thing, spelled the way docs/greenfield/restore-drill.md step 7 spells it',
  },
  {
    path: ['migrate', 'status'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'the applied schema version and the versions this tree would apply. Reads only',
  },
  {
    path: ['schema-version'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'the applied schema version and both declared ranges. Reads only',
  },
  {
    path: ['admin', 'counts'],
    valueFlags: ['--as-of', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'the five protected kinds Appendix G 11 counts, as of an instant',
  },
  {
    path: ['admin', 'holds', 'list'],
    valueFlags: ['--reason', '--exclude-reason', ...REPORTABLE],
    booleanFlags: ['--count'],
    requiredFlags: [],
    summary: 'every open hold, by reason code. `--count` prints a bare integer',
  },
  {
    path: ['admin', 'dial-authorize'],
    valueFlags: ['--firm', '--route', '--contact', '--identity', ...REPORTABLE],
    booleanFlags: ['--any'],
    requiredFlags: [],
    summary: 'run authorizeDial and report its decision. `--any` picks a dialable subject',
  },
  {
    path: ['admin', 'suppression-journal', 'replay'],
    valueFlags: ['--from', '--to', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: ['--from'],
    summary: 'insert every journalled suppression the database is missing, idempotently',
  },
  {
    path: ['admin', 'mailbox', 'reconcile-sent'],
    valueFlags: ['--since', '--mailbox', ...REPORTABLE],
    booleanFlags: ['--all-mailboxes'],
    requiredFlags: ['--since'],
    oneOf: ['--all-mailboxes', '--mailbox'],
    summary: 'search every Sent folder for FSS Message-IDs and tombstone the missing fences',
  },
  {
    path: ['admin', 'mailbox', 'recover'],
    valueFlags: ['--since', '--mailbox', ...REPORTABLE],
    booleanFlags: ['--all-mailboxes'],
    requiredFlags: ['--since'],
    oneOf: ['--all-mailboxes', '--mailbox'],
    summary: 'bounded recovery sync, so replies, opt-outs, direct sends and bounces reapply',
  },
  {
    path: ['admin', 'mailbox', 'watch-renew'],
    valueFlags: ['--mailbox', ...REPORTABLE],
    booleanFlags: ['--all-mailboxes'],
    requiredFlags: [],
    oneOf: ['--all-mailboxes', '--mailbox'],
    summary: 're-issue users.watch against this environment’s own Pub/Sub topic',
  },
  {
    path: ['admin', 'mailbox', 'coverage'],
    valueFlags: ['--mailbox', ...REPORTABLE],
    booleanFlags: ['--all-mailboxes'],
    requiredFlags: [],
    oneOf: ['--all-mailboxes', '--mailbox'],
    summary: 'the coverage watermark of every mailbox, and whether it is complete',
  },
  {
    path: ['admin', 'jobs', 'discard-runnable'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'discard queued, running and retryable jobs. Dead jobs are kept (13.2)',
  },
  {
    path: ['admin', 'scheduler', 'run-once'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'one bounded scheduler pass, which rematerialises what is genuinely due',
  },
  {
    path: ['admin', 'restore-report'],
    valueFlags: ['--before', '--at-failure', '--journal', '--sent', '--inbox', '--out'],
    booleanFlags: [],
    requiredFlags: ['--out'],
    summary: 'Appendix E step 8: the reconciliation counts and the unresolved exceptions',
  },
  {
    path: ['admin', 'system-generation', 'advance'],
    valueFlags: ['--report', '--admin-user', '--notes'],
    booleanFlags: [],
    requiredFlags: ['--report'],
    summary: 'Appendix E step 9. `--report` is the step 8 report it refuses without',
  },
]);

export type FssParseRefusal =
  | 'command_missing'
  | 'command_unknown'
  | 'flag_unknown'
  | 'flag_value_missing'
  | 'flag_missing'
  | 'flag_repeated'
  | 'selection_missing';

export interface ParsedFssCommand {
  readonly spec: FssCommandSpec;
  readonly options: Readonly<Record<string, string>>;
  readonly switches: ReadonlySet<string>;
}

export type FssParseResult =
  | { readonly ok: true; readonly value: ParsedFssCommand }
  | { readonly ok: false; readonly reason: FssParseRefusal; readonly detail: string };

/** The longest command path that matches the front of `argv`, or null. */
function matchSpec(argv: readonly string[]): FssCommandSpec | null {
  let best: FssCommandSpec | null = null;
  for (const spec of FSS_COMMANDS) {
    const matches = spec.path.every((word, index) => argv[index] === word);
    if (!matches) continue;
    if (best === null || spec.path.length > best.path.length) best = spec;
  }
  return best;
}

export function parseFssCommand(argv: readonly string[]): FssParseResult {
  if (argv.length === 0) return { ok: false, reason: 'command_missing', detail: describeCommands() };
  const spec = matchSpec(argv);
  if (spec === null) {
    return { ok: false, reason: 'command_unknown', detail: argv.filter(word => !word.startsWith('--')).join(' ') };
  }

  const rest = argv.slice(spec.path.length);
  const options: Record<string, string> = {};
  const switches = new Set<string>();

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === undefined) continue;
    if (!flag.startsWith('--')) {
      // A bare word after the command path is a subcommand this tool does not have.
      return { ok: false, reason: 'command_unknown', detail: [...spec.path, flag].join(' ') };
    }
    if (spec.booleanFlags.includes(flag)) {
      if (switches.has(flag)) return { ok: false, reason: 'flag_repeated', detail: flag };
      switches.add(flag);
      continue;
    }
    if (!spec.valueFlags.includes(flag)) return { ok: false, reason: 'flag_unknown', detail: flag };
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, reason: 'flag_value_missing', detail: flag };
    }
    if (options[flag] !== undefined) return { ok: false, reason: 'flag_repeated', detail: flag };
    options[flag] = value;
    index += 1;
  }

  for (const required of spec.requiredFlags) {
    if (options[required] === undefined && !switches.has(required)) {
      return { ok: false, reason: 'flag_missing', detail: required };
    }
  }
  if (spec.oneOf !== undefined) {
    const chosen = spec.oneOf.filter(flag => options[flag] !== undefined || switches.has(flag));
    if (chosen.length !== 1) return { ok: false, reason: 'selection_missing', detail: spec.oneOf.join(' or ') };
  }

  return { ok: true, value: { spec, options, switches } };
}

/** The usage text. Every command, its flags, and one line about what it does. */
export function describeCommands(): string {
  const lines = ['fss <command> [--flag value]', ''];
  for (const spec of FSS_COMMANDS) {
    const flags = [...spec.booleanFlags, ...spec.valueFlags.map(flag => `${flag} <value>`)].join(' ');
    lines.push(`  fss ${spec.path.join(' ')} ${flags}`.trimEnd());
    lines.push(`      ${spec.summary}`);
  }
  return lines.join('\n');
}

export interface DrillInvocation {
  /** The command as the drill writes it, with shell variables replaced. */
  readonly text: string;
  readonly argv: readonly string[];
  /** True when the line is a `rehearsal_plan` line rather than a real call. */
  readonly planned: boolean;
}

/** Where a command ends and prose, redirection or shell syntax begins. */
const TAIL = [' -> ', ' > ', ' >> ', ' | ', ' && ', ' ; ', ')', '#'];

/**
 * Every `fss` invocation in the restore drill script.
 *
 * The extractor is deliberately literal: it takes the text after each `fss` word,
 * cuts at the first shell or prose boundary, and replaces every `$VARIABLE` with a
 * placeholder, because what is being checked is the command and its flag *names* —
 * the values are instants and paths the drill computes at run time.
 *
 * It lives beside the grammar rather than in the test so that `fss` itself can be
 * asked "does this script only call things you have?" without vitest.
 */
export function drillInvocations(script: string): readonly DrillInvocation[] {
  const joined = script.replaceAll('\\\n', ' ');
  const found: DrillInvocation[] = [];
  for (const rawLine of joined.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const planned = line.includes('rehearsal_plan');
    for (const match of line.matchAll(/(?:^|[\s"'($])fss\s+(.*)$/gu)) {
      let tail = match[1] ?? '';
      for (const boundary of TAIL) {
        const at = tail.indexOf(boundary);
        if (at >= 0) tail = tail.slice(0, at);
      }
      const argv = tail
        .split(/\s+/u)
        .filter(word => word.length > 0)
        .map(word => word.replaceAll('"', '').replaceAll("'", ''))
        .map(word => (word.includes('$') ? '/tmp/fss-drill-value' : word));
      if (argv.length === 0) continue;
      found.push({ text: `fss ${argv.join(' ')}`, argv, planned });
    }
  }
  return found;
}
