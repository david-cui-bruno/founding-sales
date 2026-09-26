#!/usr/bin/env node
// Production smoke checks (specification 16.2, 13.3).
//
//   node scripts/productionSmoke.mjs --origin https://api.usecallie.com \
//        --canary-age-seconds "$(aws cloudwatch get-metric-statistics --namespace FSS/fss-prod ... )" \
//        [--expect-sending disabled|enabled] [--json]
//
// 16.2: "Production receives safe health, schema-range, connectivity, synthetic-canary,
// and sending-disabled smoke checks." Six checks, all read-only. Every Appendix G case
// that could change state belongs in rehearsal, and this file must stay the sort of
// thing an operator can run at three in the morning without thinking.
//
// ## What "safe" means here, precisely
//
// Only GET, only the unauthenticated surface, no command id — so nothing it does can
// be a mutation even by accident. It reads three endpoints and one number:
//
//   1. `/healthz`  — liveness. No database, so it answers while the rest of the
//                    process is having its worst day.
//   2. `/readyz`   — readiness: the database answered and the schema range is
//                    accepted (there is no system generation to pin since W3-S8).
//   3. `/health`   — the operator-facing report, which is where `sendingEnabled` is.
//                    Compared with `--expect-sending`, the deployment state the operator
//                    says this release should have (below).
//   4. the canary age, which is a CloudWatch metric rather than an HTTP field. It is
//      passed in, so this script needs no AWS credential of its own; the exact command
//      to produce it is in `docs/greenfield/release.md`. It is read from the
//      environment's own namespace, `FSS/<prefix>` (`FSS/fss-prod`), never the bare
//      `FSS` every environment once shared: the tenth full rehearsal's smoke read
//      production's canary age that way (g42, lane g55).
//
// ## What the canary age is
//
// `CanaryCompletionAgeSeconds` is the newest canary run's **scheduler-to-worker
// latency**: the gap between the scheduler inserting the run and the worker completing
// it, and `now() - inserted_at` while it has not been completed
// (`packages/domain/jobs/canary.ts`). It is not the time since the last completion.
// That is the distinction this check turns on, because the canary is inserted once per
// quarter hour: read as a time-since-completion the value sawtooths to 900 on a
// perfectly healthy system and this check fails for about ten minutes in every fifteen,
// which is what the first production smoke did on 23 September 2026 (`age=359.441672s`,
// release.md 8.0r). Read as a latency it stays at a few seconds while the path works
// and passes 300 within five minutes of the worker stopping, which is what 13.3 asks.
//
// ## The vacuous-pass trap
//
// A smoke script that treats a missing field as a pass reports green against a build
// that has no idea what it was asked, and a canary check that skipped itself when the
// metric was unavailable would report green against a scheduler that has been dead for
// an hour. So every check names the field it read, an absent or unparseable field is a
// failure with that name in it, and the canary is a **failure** when its age was not
// supplied rather than a skip. There is no "probably fine" branch anywhere in the file.
//
// ## The expected sending state (lane g80, audit item O12)
//
// 16.2 names a *sending-disabled* check because, when it was written, sending had never
// been on, and until lane g80 the sixth check passed only on `sendingEnabled === false`.
// Section 6 of `docs/greenfield/release.md` is how sending is turned on, and from that
// day every ordinary deployment would have failed its smoke for being exactly what it
// should be. So the expected state is an input: `--expect-sending disabled` (the
// default, which is the state every environment starts in and the rehearsal always
// has) or `--expect-sending enabled`, and the check is named for what it expects —
// `sending_disabled` or `sending_enabled` — so a PASS line says which state it
// confirmed. Anything else is a refusal to run, never a guess: a smoke that quietly
// accepted either state would pass a deployment that had flipped sending by accident,
// which is the one thing this check is for.
//
// Exit codes: 0 all checks passed; 1 a check failed; 2 the script could not run.

import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * 13.3: "canary not completed within five minutes" — five minutes of *latency* on the
 * newest run, the same number and the same meaning as the `canary_stale` alarm's
 * `var.canary_stale_seconds`.
 */
export const CANARY_MAXIMUM_AGE_SECONDS = 300;

/**
 * The six checks 16.2 names, in the order this script runs them. The sixth is named for
 * the sending state it expects: `sending_disabled` by default, `sending_enabled` under
 * `--expect-sending enabled` (`sendingCheckName`).
 */
export const SMOKE_CHECKS = Object.freeze([
  'health',
  'readiness',
  'schema_range',
  'connectivity',
  'canary',
  'sending_disabled',
]);

/** The two deployment states `--expect-sending` accepts. The first is the default. */
export const SENDING_EXPECTATIONS = Object.freeze(['disabled', 'enabled']);

/** The sixth check's name, for the state it expects. Refuses any other state. */
export function sendingCheckName(expectation) {
  if (!SENDING_EXPECTATIONS.includes(expectation)) throw new Error(`SMOKE_BAD_EXPECT_SENDING:${String(expectation)}`);
  return `sending_${expectation}`;
}

export function parseArguments(argv) {
  const options = {
    origin: null,
    json: false,
    timeoutMilliseconds: 10_000,
    canaryAgeSeconds: null,
    expectSending: SENDING_EXPECTATIONS[0],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--origin') {
      options.origin = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === '--canary-age-seconds') {
      options.canaryAgeSeconds = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === '--expect-sending') {
      options.expectSending = argv[index + 1] ?? null;
      index += 1;
      sendingCheckName(options.expectSending);
    } else if (argument === '--timeout-ms') {
      options.timeoutMilliseconds = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--json') {
      options.json = true;
    } else {
      throw new Error(`SMOKE_BAD_ARGUMENT:${argument}`);
    }
  }
  if (options.origin === null) throw new Error('SMOKE_ORIGIN_REQUIRED');
  const url = new URL(options.origin);
  // Production is HTTPS only; there is no port 80 listener by design, and a check that
  // quietly accepted http:// would be checking something other than production.
  if (url.protocol !== 'https:') throw new Error('SMOKE_ORIGIN_MUST_BE_HTTPS');
  options.origin = url.origin;
  return options;
}

/**
 * The schema range this checkout says the API image accepts.
 *
 * Read from the source rather than from a literal, for the reason the image workflow
 * reads it the same way: the two ranges differ and a lane that widens one must not have
 * to remember this file.
 */
export async function declaredSchemaRanges() {
  const module = await import(`${REPOSITORY_ROOT}packages/domain/db/schemaRange.ts`);
  return { api: module.API_SCHEMA_RANGE, worker: module.WORKER_SCHEMA_RANGE };
}

/** A field that must be there. Absent, null and undefined are all failures by name. */
function required(body, path) {
  let value = body;
  for (const key of path.split('.')) {
    if (value === null || value === undefined || typeof value !== 'object') {
      throw new Error(`SMOKE_FIELD_MISSING:${path}`);
    }
    value = value[key];
  }
  if (value === null || value === undefined) throw new Error(`SMOKE_FIELD_MISSING:${path}`);
  return value;
}

async function readJson(fetchImplementation, url, timeoutMilliseconds) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    const response = await fetchImplementation(url, { method: 'GET', signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the six checks. Returns one result per check; it never throws for a failed check,
 * only for a failure to run at all.
 */
export async function runSmoke(options, dependencies = {}) {
  // `fetch` is a Node global; naming it through an injected dependency keeps the tests
  // off the network entirely.
  const fetchImplementation = dependencies.fetch ?? fetch;
  const ranges = dependencies.ranges ?? (await declaredSchemaRanges());
  const results = [];
  const record = (name, passed, detail) => results.push({ name, passed, detail });

  const live = await readJson(fetchImplementation, `${options.origin}/healthz`, options.timeoutMilliseconds);
  record(
    'health',
    live.status === 200 && live.body?.status === 'live',
    `status=${String(live.status)} body.status=${String(live.body?.status)}`,
  );

  const ready = await readJson(fetchImplementation, `${options.origin}/readyz`, options.timeoutMilliseconds);
  record(
    'readiness',
    ready.status === 200 && ready.body?.ready === true,
    `status=${String(ready.status)} reason=${String(ready.body?.reason)}`,
  );

  if (ready.body === null || typeof ready.body !== 'object') {
    record('schema_range', false, 'SMOKE_READINESS_NOT_JSON');
    record('connectivity', false, 'SMOKE_READINESS_NOT_JSON');
  } else {
    try {
      const minimum = Number(required(ready.body, 'schema.declaredRange.minimum'));
      const maximum = Number(required(ready.body, 'schema.declaredRange.maximum'));
      const accepted = required(ready.body, 'schema.accepted') === true;
      const matches = minimum === ranges.api.minimum && maximum === ranges.api.maximum;
      record(
        'schema_range',
        matches && accepted,
        `deployed=${String(minimum)}-${String(maximum)} checkout=${String(ranges.api.minimum)}-${String(ranges.api.maximum)} accepted=${String(accepted)}`,
      );
    } catch (error) {
      record('schema_range', false, error.message);
    }

    try {
      // The API's own word for it. A version number means the database answered; the
      // schema reason `database_unreachable` means it did not. A 200 status alone
      // would read as connectivity when the task is merely alive.
      const version = required(ready.body, 'schema.databaseVersion');
      const reason = ready.body.schema?.reason ?? null;
      record(
        'connectivity',
        Number.isInteger(version) && reason !== 'database_unreachable',
        `databaseVersion=${String(version)} reason=${String(reason)}`,
      );
    } catch (error) {
      record('connectivity', false, error.message);
    }
  }

  // 13.3: "canary not completed within five minutes". The age is the newest canary
  // run's scheduler-to-worker latency — insert to completion, or insert to now while it
  // is uncompleted — so a healthy system reads a few seconds at any moment rather than
  // a sawtooth that climbs to 900 between quarter hours (8.0r). It comes from
  // CloudWatch, so it is supplied rather than fetched — and an absent one is a failed
  // check. A canary that skipped itself when the metric was unavailable would report
  // green against a scheduler that has been dead for an hour.
  if (options.canaryAgeSeconds === null || options.canaryAgeSeconds === '') {
    record('canary', false, 'SMOKE_CANARY_AGE_NOT_SUPPLIED');
  } else {
    const age = Number(options.canaryAgeSeconds);
    record(
      'canary',
      Number.isFinite(age) && age >= 0 && age <= CANARY_MAXIMUM_AGE_SECONDS,
      `age=${String(options.canaryAgeSeconds)}s limit=${String(CANARY_MAXIMUM_AGE_SECONDS)}s`,
    );
  }

  // Named before anything is read, so a bad expectation is a refusal to run (exit 2)
  // rather than a failed check, and never a pass.
  const expectation = options.expectSending ?? SENDING_EXPECTATIONS[0];
  const sendingCheck = sendingCheckName(expectation);
  const health = await readJson(fetchImplementation, `${options.origin}/health`, options.timeoutMilliseconds);
  try {
    // 16.2. `sendingEnabled` here is the *deployment* half; the admin attestation is the
    // other and is read from the admin surface, because it is workspace state rather
    // than process state. It must be a boolean and must be the state the operator
    // expects: a truthy string is neither.
    const enabled = required(health.body, 'sendingEnabled');
    record(
      sendingCheck,
      typeof enabled === 'boolean' && enabled === (expectation === 'enabled'),
      `sendingEnabled=${String(enabled)} expected=${expectation}`,
    );
  } catch (error) {
    record(sendingCheck, false, error.message);
  }

  return results;
}

export function report(results, asJson) {
  if (asJson) return JSON.stringify({ results, passed: results.every(entry => entry.passed) }, null, 2);
  return results
    .map(entry => `${entry.passed ? 'PASS' : 'FAIL'} ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`)
    .join('\n');
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
  if (options !== undefined) {
    try {
      const results = await runSmoke(options);
      console.error(report(results, options.json));
      process.exitCode = results.every(entry => entry.passed) ? 0 : 1;
    } catch (error) {
      console.error(`SMOKE_COULD_NOT_RUN:${error.message}`);
      process.exitCode = 2;
    }
  }
}
