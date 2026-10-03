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
  // Lane W3-S8 third review: the marker a restore writes to the instance it replaces,
  // before anything stops, so reconcile-sent can tell that instance from the copy.
  'restore-marker put': 'database',
  'workspace bootstrap': 'database',
  // Lane g71. The release record lives in PostgreSQL and nowhere else; the command
  // never reads the deployment, so it cannot reach Gmail, KMS or S3.
  'release-record put': 'database',
  'release-record show': 'database',
  // Lane W3-F. Counts, in a READ ONLY transaction, and nothing else. (Lane W2-M's
  // `schema-preflight 0019` went with the schema it counted: it only ever applied to a
  // schema-18 database, and production is past it.)
  'schema-preflight 0020': 'database',
  // Lane W3-C2, the same shape for migration 0021.
  'schema-preflight 0021': 'database',
  // Lane RB. The nine read-before-lift reads, in one READ ONLY transaction: PostgreSQL
  // and nothing else, so a report of what the send path would do cannot itself reach a
  // mailbox.
  'send-path report': 'database',
  // Slice S3X (CC2b): the contacts 0037 made undialable, ids and counts, READ ONLY.
  'stop-channels report': 'database',
  // Slice S3T-E: the trial's calls, encrypted to David's public key, READ ONLY.
  'trial export': 'database',
  // Call-to-booking A2: the mailbox switch's two reads, each one READ ONLY transaction.
  'mailbox switch-preflight': 'database',
  'send-path preview': 'database',
  // Slice A4. The release idle check reads in one READ ONLY transaction; the drain is
  // one audited write. PostgreSQL and nothing else.
  'release idle-check': 'database',
  'release drain on': 'database',
  'release drain off': 'database',
  // Call-to-booking (slice W): the 0028 remap's before-and-after counts, READ ONLY.
  'pipeline stage-counts': 'database',
  // Lane PBM: whether a CSV import's firms are in a workspace, five counts, READ ONLY.
  'import-match report': 'database',
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
    // Lane RS-2. One migration task instead of two: `migrate` and then
    // `admin database-users ensure`, in that order, under the one RunTask start
    // latency. `--migrate-report` and `--users-report` write each step's own report,
    // byte for byte the shape the two commands write on their own, so anything that
    // reads those files reads the same thing; stdout carries both under one object.
    path: ['release-prepare'],
    valueFlags: ['--runtime-secret', '--migrate-report', '--users-report', ...REPORTABLE],
    booleanFlags: ['--allow-any-role'],
    requiredFlags: [],
    summary: 'migrate, then ensure the runtime database user: the two migration-identity steps of a schema release, in one task',
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
    valueFlags: ['--note', '--hold', '--resolution', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: ['--note'],
    summary:
      'release restore_in_progress holds from before (or the one --hold names; an unattached-send hold needs --resolution), attributed to the verified launcher, with an audit row each',
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
    summary: 'every mailbox, its address and its status (read-only)',
  },
  {
    path: ['admin', 'restore-marker', 'put'],
    valueFlags: ['--marker', '--restore-point', '--instance', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: ['--marker', '--restore-point', '--instance'],
    summary:
      'write a restore marker (a UUID bound to the restore point and the pinned instance) into every workspace\'s audit trail on the instance this task reaches: the restore writes a fresh one before anything stops, and reconcile-sent requires it, bound the same way, on the inventory host and absent from the copy',
  },
  {
    // Lane W3-S8 reviews: the mailboxes are every one the instance being replaced has,
    // read by the command from --inventory-host, never the restored copy's alone (which
    // cannot know a mailbox connected after the restore point) and never a list somebody
    // typed. There is no --all-mailboxes and no --inventory.
    path: ['admin', 'mailbox', 'reconcile-sent'],
    valueFlags: ['--since', '--restore-point', '--inventory-host', '--inventory-marker', '--inventory-instance', ...REPORTABLE],
    booleanFlags: ['--hold-unattached'],
    requiredFlags: ['--since', '--inventory-host', '--inventory-marker', '--inventory-instance', '--restore-point'],
    summary:
      'after a point-in-time restore: read the Sent folder of every mailbox the replaced instance has (read-only Gmail) and record the sends the restored copy lost; refuses while anything could let a send repeat',
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
    // Lane g71. What `deploy.sh release --release-record` runs after the final verify,
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
    // Lane W3-F. What `infra/scripts/preflight.sh <root> <prefix> 0020` runs before the
    // postal-address release stops anything: the settings rows by key, the unsent fences
    // whose footer will be recomposed, the templates whose legacy block will be deduped,
    // and every body that would not fit once composed.
    path: ['admin', 'schema-preflight', '0020'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'what migration 0020 recomposes, dedupes or refuses on, counted read-only on schema 19',
  },
  {
    // Lane W3-C2. What `infra/scripts/preflight.sh <root> <prefix> 0021` runs before the
    // compatibility-cleanup release stops anything: the enrollments still in
    // `review_required`, which are the only thing 0021 refuses on (FS021), and the
    // credential and generation rows it will destroy without asking.
    path: ['admin', 'schema-preflight', '0021'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'what migration 0021 destroys or refuses on, counted read-only on schema 20',
  },
  {
    // Lane RB. The eight reads at the bottom of
    // `docs/greenfield/send-path-verification-20260929.md`, plus a ninth on
    // `follow_up_permissions`, as one command: the document tells the operator to run
    // them "as the read-only reporting role", and there is no such role and no way to
    // reach production's private instance to use one. `--workspace` is optional while
    // the database holds exactly one workspace, and the command refuses rather than
    // pick when it holds more.
    path: ['admin', 'send-path', 'report'],
    valueFlags: ['--workspace', '--sample', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary:
      'the nine read-before-lift reads of the send-path verification, in one READ ONLY transaction. Reads only, and decides nothing',
  },
  {
    // Slice S3T-E (David's approval, 2 October): what the ten-call trial counts, for his own
    // review on his Mac through AWS Bedrock. Printed encrypted; never a file, never a report.
    path: ['admin', 'trial', 'export'],
    valueFlags: ['--public-key-pem-b64', '--workspace-slug', '--workspace-id', '--since', '--max-calls'],
    booleanFlags: [],
    requiredFlags: ['--public-key-pem-b64'],
    oneOf: ['--workspace-slug', '--workspace-id'],
    summary:
      'the trial calls GET /calls/trial counts (transcripts, suggestions, evidence, decisions, outcome; no audio, numbers, addresses or names), AES-256-GCM under a key wrapped with RSA-OAEP-SHA256 to --public-key-pem-b64 (RSA >= 3072), in one READ ONLY transaction',
  },
  {
    // Slice S3X (contract check CC2b, DESIGN-S3X §0.1): read once right after the release
    // that applies 0037, because production has no read path before it.
    path: ['admin', 'stop-channels', 'report'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary:
      'the contacts migration 0037 made undialable (a pre-0037 stop on their address, a phone route, nothing else stopping calls), as ids and counts, in one READ ONLY transaction',
  },
  {
    // Call-to-booking A2. What the operator reads before David consents to the new
    // account (`docs/greenfield/mail.md`, "Switching the mailbox").
    path: ['admin', 'mailbox', 'switch-preflight'],
    valueFlags: ['--workspace', '--mailbox', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary:
      'the mailbox, what references it, and the conditions under which a switch should wait (wouldRefuse), in one READ ONLY transaction. Reads only',
  },
  {
    // Call-to-booking A2. Each send-path condition asked on its own, because the gate
    // stops at the first refusal and the domain switch is off while sending is paused.
    path: ['admin', 'send-path', 'preview'],
    valueFlags: ['--workspace', '--sample', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary:
      'for every prepared or held fence and every due e-mail step, each send condition evaluated independently, and the sender it would leave from. Reads only',
  },
  {
    // Slice A4. What `infra/scripts/stop.sh` asks before it stops production.
    path: ['admin', 'release', 'idle-check'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'whether production is idle (no call, no recent API command, no uninterruptible running job), in one READ ONLY transaction',
  },
  {
    path: ['admin', 'release', 'drain', 'on'],
    valueFlags: ['--minutes', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'turn the release drain on (default 20 minutes, at most 60): the API refuses new call sessions until it lapses or is turned off',
  },
  {
    path: ['admin', 'release', 'drain', 'off'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary: 'turn the release drain off',
  },
  {
    path: ['admin', 'pipeline', 'stage-counts'],
    valueFlags: [...REPORTABLE],
    booleanFlags: [],
    requiredFlags: [],
    summary:
      'every workspace\'s stages with their open, won and lost opportunities, pins and 0028 remap moves, in one READ ONLY transaction',
  },
  {
    // Lane PBM: a prepared-brief file previewed as every row unmatched in production, and
    // production has no read-only SQL path. Counts only: the log is CloudWatch.
    path: ['admin', 'import-match', 'report'],
    valueFlags: ['--workspace-id', '--external-id-prefix', ...REPORTABLE],
    booleanFlags: [],
    requiredFlags: ['--workspace-id', '--external-id-prefix'],
    summary:
      'whether a CSV import\'s firms are in the workspace: active firms, external-id aliases with the prefix (on active and on merged firms) and firms created in the last 7 days, as counts only, in one READ ONLY transaction',
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
