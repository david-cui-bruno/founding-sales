/**
 * The `fss` command line's grammar, as data (lane G12g).
 *
 * Parsing is separated from doing so that the whole argument surface is testable
 * without a database, a cloud credential or a file, and an operator's typo is refused by
 * name rather than silently treated as a default. A flag nobody passes is not here.
 *
 * Every command prints one JSON object on stdout, and `--report <path>` writes the same
 * bytes to a file.
 */

export type FssFlag = string;

export interface FssCommandSpec {
  /** `['admin', 'mailbox', 'reconcile-sent']`. The words before the first `--flag`. */
  readonly path: readonly string[];
  /** Flags that take the next argument as their value. */
  readonly valueFlags: readonly FssFlag[];
  /** Flags that are their own value. */
  readonly booleanFlags: readonly FssFlag[];
  /** Value flags without which the command refuses. */
  readonly requiredFlags: readonly FssFlag[];
  /**
   * A closed set of which exactly one must be present, or the command refuses with
   * `selection_missing`. `--json` versus `--json-base64`: one record, from exactly one
   * place, never a default a tool reaches by omission.
   */
  readonly oneOf?: readonly FssFlag[];
  readonly summary: string;
}

/** Every flag that names a path a report is written to. */
export const REPORT_FLAG = '--report';

const REPORTABLE = [REPORT_FLAG] as const;

/**
 * Which dependencies each `fss admin` command is allowed to resolve (David's
 * condition 2, 21 September).
 *
 * Fixed per command, as data, and asserted by a test rather than left to whatever the
 * environment happens to say:
 *
 *   * `database` — PostgreSQL and nothing else. The command never reads the deployment,
 *     so it cannot reach Gmail, KMS or S3 even if the whole configuration is present.
 *   * `journal` — the configured suppression-journal bucket, read only, and nothing else.
 *   * `gmail-read` — the Gmail seam the deployment names (`FSS_DEPENDENCIES=live` in
 *     production, `recorded` in a test), and only through `readOnlyGmail`, which refuses
 *     every call that sends, watches, revokes, exchanges a code or reads a body. The
 *     restore runbook runs `mailbox reconcile-sent` against production's real mailboxes
 *     (`docs/greenfield/runbooks/restore.md`), so "it cannot send" is a property of the
 *     client it is handed, not a promise about what the code downstream happens to call.
 */
export type DependencyMode = 'database' | 'journal' | 'gmail-read';

export const COMMAND_DEPENDENCIES: Readonly<Record<string, DependencyMode>> = Object.freeze({
  'database-users ensure': 'database',
  'holds list': 'database',
  // Lane W3-S8: the audited clearance of a restore hold left from before, and the
  // read-only mailbox listing the restore runbook takes its inventory from.
  'holds release-restore': 'database',
  'mailbox list': 'database',
  'workspace bootstrap': 'database',
  // Lane g71. The release record lives in PostgreSQL and nowhere else; the command
  // never reads the deployment, so it cannot reach Gmail, KMS or S3.
  'release-record put': 'database',
  'release-record show': 'database',
  // Lane W2-M. Counts, in a READ ONLY transaction, and nothing else.
  'schema-preflight 0019': 'database',
  'suppression-journal replay': 'journal',
  'mailbox reconcile-sent': 'gmail-read',
});

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
    summary: 'the same thing, spelled the long way',
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
    path: ['verify'],
    valueFlags: ['--actor', '--note', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'schema version, configured parts, and one committed write and read. No business rows',
  },
  {
    path: ['admin', 'database-users', 'ensure'],
    valueFlags: ['--runtime-secret', ...REPORTABLE],
    booleanFlags: ['--rotate-password'],
    requiredFlags: [],
    summary: 'create or alter the runtime login user from its secret, and grant migration to this user',
  },
  {
    path: ['admin', 'holds', 'list'],
    valueFlags: ['--reason', '--exclude-reason', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'every open hold, by reason code',
  },
  {
    path: ['admin', 'holds', 'release-restore'],
    valueFlags: ['--admin-user', '--note', '--hold', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: ['--admin-user', '--note'],
    summary:
      'release the open restore_in_progress holds (or the one --hold names), attributed to an active admin, with an audit row each',
  },
  {
    path: ['admin', 'suppression-journal', 'replay'],
    valueFlags: ['--from', '--to', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: ['--from'],
    summary: 'insert every journalled suppression the database is missing, idempotently',
  },
  {
    path: ['admin', 'mailbox', 'list'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'every mailbox, its address and its status (read-only; the restore runbook reads its inventory from it)',
  },
  {
    // Lane W3-S8 review: the mailboxes come from the operator's inventory, never from
    // the restored copy alone, which cannot know a mailbox connected after the restore
    // point. There is no --all-mailboxes: "every mailbox the copy knows" is exactly the
    // selection that can miss one.
    path: ['admin', 'mailbox', 'reconcile-sent'],
    valueFlags: ['--since', '--inventory', ...REPORTABLE],
    booleanFlags: ['--hold-unattached'],
    requiredFlags: ['--since', '--inventory'],
    summary:
      'after a point-in-time restore: read the Sent folder of every inventory mailbox (read-only Gmail) and record the sends the restored copy lost; refuses while anything could let a send repeat',
  },
  {
    path: ['admin', 'workspace', 'bootstrap'],
    // `--sending-domain` (lane g57) is optional and idempotent like the rest, so 5.1a
    // can carry it on every re-run: a registered domain is reported and left alone.
    valueFlags: ['--slug', '--display-name', '--admin-email', '--time-zone', '--sending-domain', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: ['--slug', '--display-name', '--admin-email'],
    summary:
      'the first workspace, its first active admin and optionally its sending domain, in one transaction, idempotently',
  },
  {
    // Lane g71. What `release-deploy.sh --release-record` runs after the final verify,
    // on the operations task. `--json` is a file, for a laptop or a test; a one-off task
    // can be handed nothing but arguments, so the script passes the record as
    // `--json-base64`. Exactly one of the two, and neither is a default.
    path: ['admin', 'release-record', 'put'],
    valueFlags: ['--json', '--json-base64', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    oneOf: ['--json', '--json-base64'],
    summary:
      'store the release record (fss.release-record.v1, from the CI gate or a rehearsal) an admin attests to, idempotently by reference',
  },
  {
    // `--reference` rather than a bare word: the grammar refuses a word after the
    // command path, so an operator's typo is a refusal rather than a subcommand.
    path: ['admin', 'release-record', 'show'],
    valueFlags: ['--reference', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: ['--reference'],
    summary: 'the stored release record for one reference, and the digests it binds sending to. Reads only',
  },
  {
    // Lane W2-M. What `infra/scripts/schema-preflight-0019.sh` runs on the operations
    // task before the schema-19 release stops anything: migration 0019's counts, read
    // only, and whether it would refuse (FS019).
    path: ['admin', 'schema-preflight', '0019'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'what migration 0019 destroys, archives, relaxes or refuses on, counted read-only on schema 18',
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
  /** The command as the script writes it, with shell variables replaced. */
  readonly text: string;
  readonly argv: readonly string[];
  /** True when the line is a `rehearsal_plan` line rather than a real call. */
  readonly planned: boolean;
}

/** Where a command ends and prose, redirection or shell syntax begins. */
// `' ('` is here for the same reason `' -> '` is: a planned line says what the command
// would do and then, in parentheses, where it would run. That is prose about the
// launch, not an argument.
const TAIL = [' -> ', ' > ', ' >> ', ' >&2', ' | ', ' && ', ' ; ', ' (', ')', '#'];

/**
 * Lines that mention `fss` without calling it: a precondition that asks whether the
 * executable exists at all, and the `echo` that says it does not. Treating either as an
 * invocation would make the check fail on a script that is correct.
 */
const NOT_AN_INVOCATION = /(^|\s)(echo|printf)\s/u;
const LOOKUP_BEFORE = /(-v|which|type)\s*$/u;

/**
 * Every `fss` invocation in a release script (the name is the restore drill's, which
 * was its first caller; the drill was deleted by lane W3-S8).
 *
 * The extractor is deliberately literal: it takes the text after each `fss` word, cuts
 * at the first shell or prose boundary, and replaces every `$VARIABLE` with a
 * placeholder, because what is being checked is the command and its flag *names* — the
 * values are instants and paths the script computes at run time.
 *
 * It lives beside the grammar rather than in the test so that `fss` itself can be asked
 * "does this script only call things you have?" without vitest.
 */
export function drillInvocations(script: string): readonly DrillInvocation[] {
  const joined = script.replaceAll('\\\n', ' ');
  const found: DrillInvocation[] = [];
  for (const rawLine of joined.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    if (NOT_AN_INVOCATION.test(line)) continue;
    const planned = line.includes('rehearsal_plan');
    for (const match of line.matchAll(/(?:^|[\s"'($])fss\s+(.*)$/gu)) {
      if (LOOKUP_BEFORE.test(line.slice(0, match.index))) continue;
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
