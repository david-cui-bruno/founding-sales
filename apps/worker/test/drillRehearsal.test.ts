import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { repositoryContext, workspaceScope, type SessionQueryable } from '@fss/domain/db';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession } from '@fss/domain/db/testing';
import { disableCallingIdentity } from '@fss/domain/dial';
import { laterHistoryId, recordedGmailClient, type KmsTransport } from '@fss/domain/mail';
import {
  SuppressionJournalError,
  type SuppressionJournalRecord,
  type SuppressionJournalSource,
} from '@fss/domain/suppression';
import { readWorkerDeployment } from '../src/bootstrap/deployment.ts';
import { composeHandlers } from '../src/bootstrap/main.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import { main } from '../src/tools/fss.ts';
import { mailboxReconcileSentCommand, restoreReportCommand, type AdminInvocation } from '../src/tools/fss/admin.ts';
import { readToolConfig } from '../src/tools/fss/config.ts';
import { runDrill, type DrillReport, type DrillStepReport } from '../src/tools/fss/drill.ts';
import {
  seedDrillEvidence,
  type DrillEvidencePhase,
  type DrillEvidenceReport,
  type MailboxRecording,
} from '../src/tools/fss/drillEvidence.ts';
import type { MailWorkerOptions } from '../src/handlers/mail.ts';

/**
 * The rehearsal's drill, end to end, on embedded PostgreSQL (lane g59).
 *
 * The fourteenth full run (36062337914, 24 September 2026) passed step 0 and stopped at
 * step 1, and `docs/greenfield/release.md` listed five reasons the steps after it could
 * not pass either: no dialable subject, no suppression the restore loses, no fence left
 * in doubt, no envelope key the drill task could share with the seed, and no counts at
 * the moment of failure. This file runs the rehearsal's own sequence against a real
 * database and a real copy of it, and asserts how far the drill now gets and why it
 * stops where it does:
 *
 *   1. `seed-evidence --phase before`, then `--phase in-flight`, on the source;
 *   2. the baseline, `fss admin counts --as-of <target>`, on the source;
 *   3. the restore: `CREATE DATABASE … TEMPLATE source`, which is a point-in-time copy
 *      in everything that matters here — it carries the source's rows, its generation,
 *      its roles, and nothing written after it;
 *   4. `--phase after` on the source, which the copy therefore loses, and the counts at
 *      that moment of failure;
 *   5. `fss drill` against the copy, handed the baseline, the at-failure counts, the
 *      merged mailbox recording, the pin and the admin, exactly as the runner hands them.
 *
 * Each phase and the drill read their own deployment, as separate tasks do, and share
 * only what separate tasks share: a KMS key (a stand-in that enforces encryption
 * context, as KMS does), the journal bucket (a list of what was appended, read back by
 * instant as the S3 source reads LastModified), and the database.
 *
 * ## The vacuous-pass traps, named
 *
 *   * "Step 2 passed" could be the replay inserting what the copy already had. So the
 *     copy is checked to lack the after-phase suppressions *before* the drill, and the
 *     replay must insert exactly those.
 *   * "Step 3 passed" could be a send the copy already knew was sent. So the fence is
 *     checked to be `reconciling` in the copy, and the drill without the recording must
 *     fail step 3 on the same database — the Sent folder the seed filled is the proof.
 *   * "Step 4 passed" could count the before-phase effects. So the copy is checked to
 *     lack the late opt-out, and the effects counted must be ones step 4 applied.
 *   * "Step 3's missing fence was tombstoned" (lane g73) could be the in-flight fence
 *     again — a fence the copy still had, which is how the gap stayed green. So the copy is
 *     checked to hold the restore-lost step pending with no fence, the tombstone is read
 *     back on that step, and the drill without that one Sent message must fail the check.
 *   * "Step 1's dial was refused" could be a refusal at an earlier step of 9.2 for a
 *     reason of its own — there is no posture for the evidence firms' state — which says
 *     nothing about the restore. So the step must also report `restore_in_progress`
 *     among the holds that apply to that dial (lane g60), and the probe's subject must
 *     be the calling identity the seed attested, not one the drill found lying about.
 *   * "The dial probe was answered" could be a probe quietly passed without a subject.
 *     So a copy whose calling number was retired must still fail the drill, naming the
 *     probe as unanswered with the prerequisite it lacks.
 */

let adminUrl: string;
const created: string[] = [];

/** A KMS stand-in: one master key, and KMS's refusal of a decrypt under another context. */
function contextCheckingKms(): KmsTransport {
  const master = randomBytes(32);
  const label = (context: Readonly<Record<string, string>> | undefined): Buffer =>
    Buffer.from(JSON.stringify(Object.entries(context ?? {}).sort()));
  return {
    generateDataKey: async input => {
      const plaintext = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', master, iv);
      cipher.setAAD(label(input.EncryptionContext));
      const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return await Promise.resolve({ Plaintext: plaintext, CiphertextBlob: Buffer.concat([iv, cipher.getAuthTag(), body]) });
    },
    decrypt: async input => {
      const blob = Buffer.from(input.CiphertextBlob);
      const decipher = createDecipheriv('aes-256-gcm', master, blob.subarray(0, 12));
      decipher.setAAD(label(input.EncryptionContext));
      decipher.setAuthTag(blob.subarray(12, 28));
      return await Promise.resolve({ Plaintext: Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]) });
    },
  };
}

/** The bucket: what was appended, with the instant it landed, as S3's LastModified. */
function journalBucket(): {
  readonly append: (record: SuppressionJournalRecord) => Promise<void>;
  readonly source: SuppressionJournalSource;
  readonly records: { readonly record: SuppressionJournalRecord; readonly at: number }[];
} {
  const records: { record: SuppressionJournalRecord; at: number }[] = [];
  return {
    records,
    append: async record => {
      if (!records.some(entry => entry.record.eventId === record.eventId)) records.push({ record, at: Date.now() });
      await Promise.resolve();
    },
    source: {
      read: async (from, to) => {
        const fromAt = Date.parse(from);
        const toAt = to === undefined ? Number.POSITIVE_INFINITY : Date.parse(to);
        return await Promise.resolve(records.filter(entry => entry.at >= fromAt && entry.at <= toAt).map(entry => entry.record));
      },
    },
  };
}

function urlFor(name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

async function connect(name: string): Promise<{ readonly client: pg.Client; readonly session: SessionQueryable }> {
  const client = new pg.Client({ connectionString: urlFor(name) });
  await client.connect();
  return { client, session: asSession(client as never) };
}

/** Every variable a deployed rehearsal task carries that the reader needs, and the envelope key. */
function rehearsalEnvironment(): Record<string, string> {
  return {
    FSS_ENVIRONMENT: 'rehearsal',
    FSS_DEPENDENCIES: 'recorded',
    AWS_REGION: 'us-east-1',
    FSS_PUBLIC_ORIGIN: 'https://api.example.test',
    FSS_GMAIL_PUSH_AUDIENCE: 'https://api.example.test/integrations/gmail/push',
    FSS_GMAIL_PUSH_SERVICE_ACCOUNT: 'push@example.iam.gserviceaccount.test',
    FSS_GMAIL_PUSH_TOPIC: 'projects/example/topics/push',
    FSS_GOOGLE_HOSTED_DOMAIN: 'example.test',
    FSS_ENVELOPE_KEY_ID: 'arn:aws:kms:us-east-1:000000000000:key/rehearsal-envelope',
    'google-gmail-oauth-client': JSON.stringify({
      client_id: 'example.apps.googleusercontent.test',
      client_secret: `zz-${randomUUID()}-zz`,
    }),
  };
}

/**
 * One task's mail composition: its own deployment, the shared key and the shared bucket.
 *
 * `reader` is the drill's: the drill task role may read the journal and never write it
 * (`infra/modules/cluster`), so its appends are refused as S3 would refuse them. A drill
 * that had to journal something to pass would fail here as it would in the cloud.
 */
async function taskMail(
  kms: KmsTransport,
  bucket: ReturnType<typeof journalBucket>,
  role: 'writer' | 'reader' = 'writer',
): Promise<MailWorkerOptions> {
  const deployment = await readWorkerDeployment(rehearsalEnvironment(), {
    loadKms: async () => await Promise.resolve(kms),
  });
  expect(deployment.gmail?.envelopeSource).toBe('kms_recorded_seam');
  const append =
    role === 'writer'
      ? bucket.append
      : async (): Promise<void> => {
          await Promise.resolve();
          throw new SuppressionJournalError('JOURNAL_UNAVAILABLE', 'the drill task role may not write the journal');
        };
  const composition = await composeHandlers(deployment, undefined, { journal: { append }, region: 'us-east-1' });
  if (composition.mail === undefined) throw new Error('the recorded deployment composed no mail client');
  return composition.mail;
}

async function tool(name: string, argv: readonly string[]): Promise<Record<string, unknown>> {
  const printed: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await main(argv, { DATABASE_URL: urlFor(name), FSS_MIGRATION_DATABASE_URL: urlFor(name) });
    expect(code, `${argv.join(' ')} exited ${String(code)}`).toBe(0);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return JSON.parse(printed.join('')) as Record<string, unknown>;
}

/** The runner's merge of the phases' recordings, as `rehearsal-restore-drill.sh` does it. */
function mergedRecording(reports: readonly DrillEvidenceReport[]): MailboxRecording {
  const byId = new Map(reports.flatMap(report => report.mailbox.messages).map(message => [message.id, message]));
  const sentById = new Map(reports.flatMap(report => report.mailbox.sentMessages).map(message => [message.id, message]));
  return {
    emailAddress: reports[0]?.mailbox.emailAddress ?? '',
    historyId: reports.map(report => report.mailbox.historyId).reduce(laterHistoryId, '1'),
    sentMessageIds: [...new Set(reports.flatMap(report => report.mailbox.sentMessageIds))].sort(),
    messages: [...byId.values()],
    sentMessages: [...sentById.values()],
  };
}

/** The fence the after phase sent for the step the before phase enrolled (lane g73). */
async function restoreLostSend(): Promise<{ readonly header: string; readonly stepExecutionId: string; readonly fenceId: string }> {
  const { client, session } = await connect(rehearsal.source);
  try {
    const { rows } = await session.query<{ id: string; provider_message_id_header: string; step_execution_id: string }>(
      `SELECT id, provider_message_id_header, step_execution_id FROM outbound_messages
        WHERE recipient_address = 'restore-lost@drill-evidence.invalid'`,
    );
    expect(rows, 'the after phase sent the restore-lost step once').toHaveLength(1);
    const row = rows[0];
    return { header: row?.provider_message_id_header ?? '', stepExecutionId: row?.step_execution_id ?? '', fenceId: row?.id ?? '' };
  } finally {
    await client.end();
  }
}

const counted = async (session: SessionQueryable, sql: string, values: readonly unknown[] = []): Promise<number> => {
  const { rows } = await session.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
};

const five = ['sends', 'replies', 'suppressions', 'crm_edits', 'migrations'] as const;
const handed = (counts: Record<string, unknown>): string =>
  JSON.stringify(Object.fromEntries(['asOf', ...five].map(key => [key, counts[key]])));

interface Rehearsal {
  readonly source: string;
  readonly restored: string;
  readonly kms: KmsTransport;
  readonly bucket: ReturnType<typeof journalBucket>;
  readonly reports: Readonly<Record<DrillEvidencePhase, DrillEvidenceReport>>;
  readonly baseline: Record<string, unknown>;
  readonly atFailure: Record<string, unknown>;
}

let rehearsal: Rehearsal;

async function seed(
  name: string,
  phase: DrillEvidencePhase,
  kms: KmsTransport,
  bucket: ReturnType<typeof journalBucket>,
): Promise<DrillEvidenceReport> {
  const { client, session } = await connect(name);
  try {
    const outcome = await seedDrillEvidence({ session, mail: await taskMail(kms, bucket), workspaceSlug: 'rehearsal', phase });
    expect(outcome.ok, `the ${phase} phase refused: ${JSON.stringify(outcome)}`).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    return outcome.value;
  } finally {
    await client.end();
  }
}

async function drill(
  options: {
    readonly recording?: boolean;
    /** Lane g73: edits the merged recording before it is handed over. */
    readonly editRecording?: (recording: MailboxRecording) => MailboxRecording;
    readonly atFailure?: boolean;
    /** Something done to the fresh copy before the drill runs against it. */
    readonly prepare?: (session: SessionQueryable) => Promise<void>;
  } = {},
): Promise<{ readonly result: Awaited<ReturnType<typeof runDrill>>; readonly report: DrillReport; readonly copy: string }> {
  // Each drill gets a fresh copy of the restored database, so one case cannot hand the
  // next a reconstructed one.
  const copy = `fss_g59_drill_${randomUUID().replaceAll('-', '')}`;
  await admin(`CREATE DATABASE "${copy}" TEMPLATE "${rehearsal.restored}"`);
  created.push(copy);
  const { client, session } = await connect(copy);
  try {
    if (options.prepare !== undefined) await options.prepare(session);
    const mail = await taskMail(rehearsal.kms, rehearsal.bucket, 'reader');
    const reports = mkdtempSync(join(tmpdir(), 'fss-g59-drill-'));
    const result = await runDrill({
      session,
      migrationSession: session,
      invocation: {
        session,
        config: readToolConfig({ DATABASE_URL: urlFor(copy) }),
        environment: {},
        journalSource: rehearsal.bucket.source,
        mail,
        log: recordingLogger(),
      },
      baselineJson: handed(rehearsal.baseline),
      ...(options.atFailure === false ? {} : { atFailureJson: handed(rehearsal.atFailure) }),
      ...(options.recording === false
        ? {}
        : {
            mailboxRecordingJson: JSON.stringify(
              (options.editRecording ?? (recording => recording))(mergedRecording(Object.values(rehearsal.reports))),
            ),
          }),
      expectedGeneration: String(Number(rehearsal.baseline['systemGeneration']) + 1),
      reportsDirectory: reports,
      adminUserId: rehearsal.reports.before.adminUserId,
    });
    const report = (result.ok ? result.value : result.value) as DrillReport | undefined;
    if (report === undefined) throw new Error(`the drill refused before any step: ${JSON.stringify(result)}`);
    return { result, report, copy };
  } finally {
    await client.end();
  }
}

const stepOf = (report: DrillReport, name: string): DrillStepReport | undefined =>
  report.steps.find(entry => entry.step === name);
const bodyOf = (report: DrillReport, name: string): Record<string, unknown> =>
  (stepOf(report, name)?.report ?? {}) as Record<string, unknown>;

beforeAll(async () => {
  adminUrl = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '';
  expect(adminUrl.length, 'the embedded cluster URL is what globalSetup leaves').toBeGreaterThan(0);
  const source = `fss_g59_source_${randomUUID().replaceAll('-', '')}`;
  const restored = `fss_g59_restored_${randomUUID().replaceAll('-', '')}`;
  await admin(`CREATE DATABASE "${source}"`);
  created.push(source);

  await tool(source, ['migrate']);
  await tool(source, [
    'admin',
    'workspace',
    'bootstrap',
    '--slug',
    'rehearsal',
    '--display-name',
    'Rehearsal',
    '--admin-email',
    'rehearsal-admin@example.test',
  ]);

  const kms = contextCheckingKms();
  const bucket = journalBucket();
  const before = await seed(source, 'before', kms, bucket);
  const inFlight = await seed(source, 'in-flight', kms, bucket);

  // The target, and the baseline measured at it on the source.
  const baseline = await tool(source, ['admin', 'counts']);

  // The restore: a copy of the source as it stands at the target.
  await admin(`CREATE DATABASE "${restored}" TEMPLATE "${source}"`);
  created.push(restored);

  // What the restore loses, and the counts at the moment of failure.
  const after = await seed(source, 'after', kms, bucket);
  const atFailure = await tool(source, ['admin', 'counts']);

  rehearsal = {
    source,
    restored,
    kms,
    bucket,
    reports: { before, 'in-flight': inFlight, after },
    baseline,
    atFailure,
  };
}, 240_000);

afterAll(async () => {
  for (const name of created.reverse()) {
    await admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
  }
});

describe('the rehearsal leaves the restored copy something to reconstruct (lane g59)', () => {
  it('the copy holds the in-doubt fence and lacks everything the after phase did', async () => {
    const { client, session } = await connect(rehearsal.restored);
    try {
      expect(
        await counted(session, "SELECT count(*)::text AS count FROM outbound_messages WHERE state = 'reconciling'"),
        'the in-flight phase left no fence in doubt at the target',
      ).toBe(1);
      expect(
        await counted(session, "SELECT count(*)::text AS count FROM mail_messages WHERE provider_message_id = 'fss-drill-evidence-opt-out-2'"),
        'the copy already has the opt-out the restore is meant to lose',
      ).toBe(0);
      // The suppressions the after phase journalled are in the bucket and not in the copy.
      const lost = rehearsal.bucket.records.filter(entry => entry.record.canonicalKey.startsWith('late-opt-out@') || entry.record.scope === 'firm');
      expect(lost.length).toBeGreaterThanOrEqual(1);
      expect(
        await counted(session, 'SELECT count(*)::text AS count FROM suppression_events'),
      ).toBe(Number(rehearsal.baseline['suppressions']));
      expect(Number(rehearsal.atFailure['suppressions'])).toBe(Number(rehearsal.baseline['suppressions']) + 2);
      // Lane g73: the restore-lost step is in the copy, pending, with no fence at all —
      // the state Appendix E.3's missing-fence recovery exists for.
      const restoreLost = await restoreLostSend();
      expect(
        await counted(session, "SELECT count(*)::text AS count FROM step_executions WHERE id = $1 AND state = 'pending'", [
          restoreLost.stepExecutionId,
        ]),
      ).toBe(1);
      expect(
        await counted(session, 'SELECT count(*)::text AS count FROM outbound_messages WHERE step_execution_id = $1 OR id = $2', [
          restoreLost.stepExecutionId,
          restoreLost.fenceId,
        ]),
      ).toBe(0);
      // A usable phone route on an assigned firm, and (lane g60) the assignee's attested
      // calling number: the step 1 dial probe's subject, made before the target.
      expect(await counted(session, "SELECT count(*)::text AS count FROM phone_routes WHERE eligibility = 'usable'")).toBe(1);
      expect(
        await counted(
          session,
          "SELECT count(*)::text AS count FROM calling_identities WHERE enabled AND verification_status = 'verified' AND verification_method = 'owner_attestation' AND owner_user_id = $1",
          [rehearsal.reports.before.adminUserId],
        ),
      ).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('records the Sent folder of each phase, and the opt-out the after phase delivered', () => {
    expect(rehearsal.reports.before.mailbox.sentMessageIds).toHaveLength(1);
    expect(rehearsal.reports['in-flight'].mailbox.sentMessageIds).toHaveLength(1);
    // Lane g73: the after phase's two sends — the one to a firm the restore loses, and
    // the restore-lost step's — each as a message a listing returns, recipient and all.
    expect(rehearsal.reports.after.mailbox.sentMessageIds).toHaveLength(2);
    expect(rehearsal.reports.after.mailbox.sentMessages.map(message => message.headers['To']).sort()).toEqual([
      'after@drill-evidence.invalid',
      'restore-lost@drill-evidence.invalid',
    ]);
    for (const phase of ['before', 'in-flight', 'after'] as const) {
      const { sentMessageIds, sentMessages } = rehearsal.reports[phase].mailbox;
      expect(sentMessages.map(message => message.headers['Message-ID']).sort()).toEqual([...sentMessageIds].sort());
      expect(sentMessages.every(message => message.labelIds?.includes('SENT'))).toBe(true);
    }
    expect(rehearsal.reports.after.mailbox.messages.map(message => message.id)).toEqual(['fss-drill-evidence-opt-out-2']);
    expect(rehearsal.reports.before.adminUserId).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe('fss drill against the restored copy (lanes g59 and g60)', () => {
  it('runs every step and passes every step, the dial probe included, with the restore hold refusing the dial', async () => {
    const { result, report, copy } = await drill();
    const verdicts = report.steps.map(entry => [entry.step, entry.ok, entry.unanswered === true, entry.failure]);

    // A pass, for the first time: the calling number the seed attested gives the probe a
    // subject, and nothing else in the drill is left unanswered.
    expect(result.ok, JSON.stringify(verdicts)).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.stoppedAt).toBeNull();
    expect(report.unanswered).toEqual([]);
    expect(verdicts.filter(([, ok]) => ok !== true).map(([name]) => name)).toEqual([]);
    expect(report.steps.map(entry => entry.step)).toEqual([
      'step1a-generation-check',
      'step1-restore-holds',
      'step1-dial-refused',
      'step2-journal-replay',
      'step2-journal-replay-second',
      'step3-reconcile-sent',
      'step3-missing-fence-tombstoned',
      'step4-inbox-recover',
      'step5-jobs-discard',
      'step5-scheduler-run-once',
      'step5-no-second-send',
      'step6-watch-renew',
      'step6-coverage',
      'step7-migrate',
      'step8-restore-report',
      'step9-system-generation-advance',
      'step9-generation-reconciled',
    ]);

    // Step 1's dial: refused, the restore hold among the holds that apply to it, and
    // asked about the seed's own subject — the admin's attested number and the phone
    // route on the admin's firm.
    const dial = bodyOf(report, 'step1-dial-refused');
    expect(dial['allowed']).toBe(false);
    expect(dial['holds']).toContain('restore_in_progress');
    const subject = dial['subject'] as Record<string, unknown>;
    {
      const { client, session } = await connect(copy);
      try {
        const seeded = await session.query<{ id: string }>(
          'SELECT id FROM calling_identities WHERE owner_user_id = $1',
          [rehearsal.reports.before.adminUserId],
        );
        expect(subject['callingIdentityId']).toBe(seeded.rows[0]?.id);
      } finally {
        await client.end();
      }
    }

    // Step 2: exactly the after phase's two suppressions came back from the journal.
    expect(bodyOf(report, 'step2-journal-replay')['inserted']).toBe(2);
    expect(bodyOf(report, 'step2-journal-replay-second')['inserted']).toBe(0);
    // Step 3: the fence in doubt, proved by the Sent folder, and nothing sent.
    expect(bodyOf(report, 'step3-reconcile-sent')).toMatchObject({ tombstones: 1, fences_reconciled: 1, resent: 0 });
    // Lane g73, Appendix E.3's missing fences: the restore-lost step's send is tombstoned;
    // the send to the after phase's own firm, which the copy never heard of, is reported
    // and left; and every Sent folder was read to the end.
    expect(bodyOf(report, 'step3-reconcile-sent')).toMatchObject({
      missing_fences_tombstoned: 1,
      missing_fences_unmatched: 1,
      missing_fences_unattached: 0,
      pre_dispatch_fences_marked_sent: 0,
      mailboxes_unscanned: 0,
    });
    const lost = await restoreLostSend();
    const missing = bodyOf(report, 'step3-missing-fence-tombstoned');
    expect(missing['tombstones']).toEqual([
      {
        outboundMessageId: lost.fenceId,
        stepExecutionId: lost.stepExecutionId,
        state: 'sent',
        reconciledFrom: 'sent_folder_missing_fence',
        fencesForStep: 1,
        fencesToRecipient: 1,
      },
    ]);
    // Step 5: the rematerialized jobs sent nothing, and the step still has its one fence.
    expect(bodyOf(report, 'step5-no-second-send')).toMatchObject({ sends: 0 });
    {
      const { client, session } = await connect(copy);
      try {
        const tombstone = await session.query<{ state: string; header: string; completed: string }>(
          `SELECT o.state, o.provider_message_id_header AS header, e.state AS completed
             FROM outbound_messages o JOIN step_executions e ON e.workspace_id = o.workspace_id AND e.id = o.step_execution_id
            WHERE o.id = $1`,
          [lost.fenceId],
        );
        expect(tombstone.rows).toEqual([{ state: 'sent', header: lost.header, completed: 'completed' }]);
        expect(
          await counted(session, "SELECT count(*)::text AS count FROM outbound_messages WHERE recipient_address = 'restore-lost@drill-evidence.invalid'"),
        ).toBe(1);
      } finally {
        await client.end();
      }
    }
    // Step 4: the lost opt-out, recovered from the inbox and reapplied once — its
    // replayed suppression events reached rather than recorded a second time, which is
    // what lets an identity that cannot write the journal reapply it at all. (The counts
    // here also include the before phase's effects, which in this test are seconds old
    // rather than half an hour, so they fall inside the window; the rows below are the
    // proof of what step 4 itself did.)
    const recovered = bodyOf(report, 'step4-inbox-recover');
    expect(Number(recovered['replies'])).toBeGreaterThanOrEqual(1);
    expect(Number(recovered['opt_outs'])).toBeGreaterThanOrEqual(1);
    {
      const { client, session } = await connect(copy);
      try {
        const effects = await session.query<{ effect_kind: string; suppression_event_id: string | null }>(
          `SELECT e.effect_kind, e.suppression_event_id FROM mail_message_effects e
             JOIN mail_messages m ON m.workspace_id = e.workspace_id AND m.id = e.mail_message_id
            WHERE m.provider_message_id = 'fss-drill-evidence-opt-out-2'
            ORDER BY e.effect_kind`,
        );
        expect(effects.rows.map(row => row.effect_kind)).toEqual(['firm_suppressed', 'handle_suppressed', 'reply_lane_entry']);
        const journalled = new Set(rehearsal.bucket.records.map(entry => entry.record.eventId));
        for (const row of effects.rows.filter(entry => entry.suppression_event_id !== null)) {
          expect(journalled.has(row.suppression_event_id ?? ''), 'step 4 minted an event the journal never held').toBe(true);
        }
        expect(await counted(session, 'SELECT count(*)::text AS count FROM suppression_events')).toBe(
          Number(rehearsal.atFailure['suppressions']),
        );
      } finally {
        await client.end();
      }
    }
    // Step 8: measured against the moment of failure.
    const restore = bodyOf(report, 'step8-restore-report');
    expect(restore).toMatchObject({
      sends_repeated: 0,
      suppressions_before: Number(rehearsal.baseline['suppressions']),
      suppressions_at_failure: Number(rehearsal.atFailure['suppressions']),
      suppressions_after: Number(rehearsal.atFailure['suppressions']),
      sends_at_failure: Number(rehearsal.atFailure['sends']),
      at_failure_as_of: rehearsal.atFailure['asOf'],
      unresolved: [],
    });
    // The after phase's firm, contact, route, opportunity and name edit are all ordinary
    // CRM edits the restore lost, and the report says how many rather than hiding them.
    expect(Number(restore['crm_edits_lost'])).toBeGreaterThanOrEqual(1);
    expect(restore['crm_edits_lost']).toBe(Number(restore['crm_edits_at_failure']) - Number(restore['crm_edits_after']));
    // Step 9: the holds in force immediately before the advance survive it, and the
    // administrative pause the seed opened is among them. (The manual suppression's
    // review hold is the other one here; in a rehearsal the live worker finalizes it ten
    // minutes after the seed, long before the target, so the pause is what remains.)
    const advance = bodyOf(report, 'step9-system-generation-advance');
    expect(advance['restoreHoldsAfter']).toBe(0);
    expect(Number(advance['otherHoldsBefore'])).toBeGreaterThanOrEqual(1);
    expect(advance['otherHoldsAfter']).toBe(advance['otherHoldsBefore']);
    {
      const { client, session } = await connect(copy);
      try {
        expect(
          await counted(
            session,
            "SELECT count(*)::text AS count FROM active_holds WHERE reason_code = 'scoped_pause' AND released_at IS NULL",
          ),
        ).toBe(1);
        // And the in-doubt send's hold is gone because step 3 proved delivery, not
        // because step 9 cleared it: it was released before the advance was measured.
        expect(
          await counted(
            session,
            "SELECT count(*)::text AS count FROM active_holds WHERE reason_code = 'send_unknown_reconciling' AND released_at IS NULL",
          ),
        ).toBe(0);
      } finally {
        await client.end();
      }
    }
    expect(bodyOf(report, 'step9-generation-reconciled')).toMatchObject({ reconciled: true, mismatch: false, holdsOpened: 0 });
  }, 120_000);

  it('leaves the dial probe unanswered, and the drill failed, on a copy whose calling number was retired', async () => {
    const { result, report } = await drill({
      prepare: async session => {
        const admin = rehearsal.reports.before.adminUserId;
        const context = repositoryContext(
          workspaceScope(rehearsal.reports.before.workspaceId, { kind: 'user', userId: admin, role: 'admin' }),
          session,
        );
        const identities = await session.query<{ id: string }>('SELECT id FROM calling_identities WHERE owner_user_id = $1', [
          admin,
        ]);
        for (const row of identities.rows) {
          const retired = await disableCallingIdentity(context, { identityId: row.id });
          expect(retired.ok).toBe(true);
        }
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unanswered_step1-dial-refused');
    expect(report.unanswered).toEqual(['step1-dial-refused']);
    expect(stepOf(report, 'step1-dial-refused')?.failure).toContain(
      'this database has 1 assigned firm(s) with a usable phone route and 0 verified, enabled calling identities',
    );
  }, 120_000);

  it('fails the missing-fence check when the restore-lost message is not in the Sent folder, so that message is the proof (lane g73)', async () => {
    const lost = await restoreLostSend();
    const { report } = await drill({
      editRecording: recording => ({
        ...recording,
        sentMessages: recording.sentMessages.filter(message => message.headers['Message-ID'] !== lost.header),
      }),
    });
    // The surviving in-flight fence still reconciles, exactly as it did while the gap was
    // green; only the check of its own says that is not Appendix E.3's missing fence.
    expect(stepOf(report, 'step3-reconcile-sent')?.ok).toBe(true);
    const missing = stepOf(report, 'step3-missing-fence-tombstoned');
    expect(missing?.ok).toBe(false);
    expect(missing?.failure).toContain('no send whose fence the restore lost was tombstoned');
    expect(report.stoppedAt).toBe('step3-missing-fence-tombstoned');
  }, 120_000);

  it('fails the drill rather than guess when two live enrollments reach the lost send’s recipient (lane g73)', async () => {
    const { report, copy } = await drill({
      prepare: async session => {
        // A second contact, at another firm, with the same address and a live enrollment
        // of its own: either could be the step the lost send belonged to.
        const { rows } = await session.query<{ workspace_id: string; firm_id: string; sequence_version_id: string; assigned_user_id: string }>(
          `SELECT n.workspace_id, n.firm_id, n.sequence_version_id, n.assigned_user_id FROM sequence_enrollments n
             JOIN email_addresses a ON a.workspace_id = n.workspace_id AND a.contact_id = n.contact_id
            WHERE a.address = 'restore-lost@drill-evidence.invalid'`,
        );
        const lost = rows[0];
        if (lost === undefined) throw new Error('the restore-lost enrollment is not in the copy');
        const other = await session.query<{ id: string; firm_id: string; opportunity_id: string }>(
          `SELECT f.id AS firm_id, c.id, o.id AS opportunity_id FROM firms f
             JOIN contacts c ON c.workspace_id = f.workspace_id AND c.firm_id = f.id
             JOIN opportunities o ON o.workspace_id = f.workspace_id AND o.firm_id = f.id
            WHERE f.workspace_id = $1 AND f.id <> $2 AND f.name LIKE 'Drill Evidence In Flight%'
            LIMIT 1`,
          [lost.workspace_id, lost.firm_id],
        );
        const target = other.rows[0];
        if (target === undefined) throw new Error('no second firm to share the address with');
        const contact = await session.query<{ id: string }>(
          "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Drill Evidence Shared Inbox') RETURNING id",
          [lost.workspace_id, target.firm_id],
        );
        const contactId = contact.rows[0]?.id ?? '';
        await session.query(
          `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                        association_confidence, technical_validation, eligibility, eligibility_policy_version)
           VALUES ($1, $2, $3, 'restore-lost@drill-evidence.invalid', 'salesperson', now(), 1.000, 'passed', 'usable', 'route-policy.1')`,
          [lost.workspace_id, target.firm_id, contactId],
        );
        await session.query(
          `INSERT INTO sequence_enrollments
             (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
              firm_time_zone, holiday_calendar_version)
           VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1')`,
          [lost.workspace_id, lost.sequence_version_id, target.opportunity_id, target.firm_id, contactId, lost.assigned_user_id],
        );
      },
    });
    const sent = bodyOf(report, 'step3-reconcile-sent');
    expect(sent).toMatchObject({ missing_fences_tombstoned: 0, missing_fences_unattached: 1 });
    const unattached = (sent['missing_fences'] as Record<string, unknown>[]).filter(line => line['outcome'] === 'unattached');
    expect(unattached).toHaveLength(1);
    expect(unattached[0]?.['reason']).toBe('several_live_enrollments');
    expect(report.stoppedAt).toBe('step3-missing-fence-tombstoned');

    // And step 8, run by hand on the same copy, lists it as an unresolved exception, which
    // is what refuses step 9 (verifyRestoreReport): the restore holds stay on.
    const { client, session } = await connect(copy);
    try {
      const directory = mkdtempSync(join(tmpdir(), 'fss-g73-report-'));
      writeFileSync(join(directory, 'before.json'), handed(rehearsal.baseline));
      writeFileSync(join(directory, 'sent.json'), JSON.stringify(sent));
      const outcome = await restoreReportCommand({
        session,
        config: readToolConfig({ DATABASE_URL: urlFor(copy) }),
        environment: {},
        options: { '--before': join(directory, 'before.json'), '--sent': join(directory, 'sent.json') },
        switches: new Set(),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const unresolved = outcome.value['unresolved'] as { kind: string }[];
      expect(unresolved.map(entry => entry.kind)).toContain('unattached_sent_message');
    } finally {
      await client.end();
    }
  }, 120_000);

  it('reconcile-sent inserts each missing fence once, keeps no recipient in its report, and reads only its window (lane g73)', async () => {
    const copy = `fss_g73_tool_${randomUUID().replaceAll('-', '')}`;
    await admin(`CREATE DATABASE "${copy}" TEMPLATE "${rehearsal.restored}"`);
    created.push(copy);
    const { client, session } = await connect(copy);
    try {
      const recording = mergedRecording(Object.values(rehearsal.reports));
      const mail = await taskMail(rehearsal.kms, rehearsal.bucket, 'reader');
      const gmail = recordedGmailClient({ ...recording });
      const invocation = (since: string): AdminInvocation => ({
        session,
        config: readToolConfig({ DATABASE_URL: urlFor(copy) }),
        environment: {},
        options: { '--since': since },
        switches: new Set(['--all-mailboxes']),
        mail: { ...mail, gmail },
      });
      const lost = await restoreLostSend();
      const lostAt = recording.sentMessages.find(message => message.headers['Message-ID'] === lost.header)
        ?.internalDateEpochMilliseconds;
      expect(lostAt).toBeDefined();

      // A window that starts one millisecond after the lost send does not see it.
      const later = await mailboxReconcileSentCommand(invocation(new Date((lostAt ?? 0) + 1).toISOString()));
      expect(later.ok).toBe(true);
      if (later.ok) expect(later.value['missing_fences_tombstoned']).toBe(0);

      const since = new Date(Date.parse(String(rehearsal.baseline['asOf'])) - 600_000).toISOString();
      const first = await mailboxReconcileSentCommand(invocation(since));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value).toMatchObject({ missing_fences_tombstoned: 1, missing_fences_unattached: 0, resent: 0 });
      const text = JSON.stringify(first.value);
      expect(text).not.toContain('@drill-evidence.invalid');
      const lines = first.value['missing_fences'] as Record<string, unknown>[];
      expect(lines.every(line => /^[0-9a-f]{16}$/u.test(String(line['message'])))).toBe(true);

      const fences = await counted(session, 'SELECT count(*)::text AS count FROM outbound_messages');
      const second = await mailboxReconcileSentCommand(invocation(since));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value).toMatchObject({ missing_fences_tombstoned: 0, resent: 0 });
      expect(Number(second.value['sent_folder_present'])).toBe(Number(first.value['sent_folder_present']) + 1);
      expect(await counted(session, 'SELECT count(*)::text AS count FROM outbound_messages')).toBe(fences);
      expect(gmail.sends).toHaveLength(0);
    } finally {
      await client.end();
    }
  }, 120_000);

  it('fails step 3 on the same copy without the recorded Sent folder, so the recording is the proof', async () => {
    const { report } = await drill({ recording: false });
    const sent = stepOf(report, 'step3-reconcile-sent');
    expect(sent?.ok).toBe(false);
    expect(sent?.failure).toContain('no send was reconstructed');
    expect(report.stoppedAt).toBe('step3-reconcile-sent');
  }, 120_000);
});
