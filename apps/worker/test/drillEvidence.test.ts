import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession } from '@fss/domain/db/testing';
import type { SuppressionJournalRecord } from '@fss/domain/suppression';
import { readWorkerDeployment } from '../src/bootstrap/deployment.ts';
import { composeHandlers } from '../src/bootstrap/main.ts';
import { main } from '../src/tools/fss.ts';
import { seedDrillEvidence, windowInstant } from '../src/tools/fss/drillEvidence.ts';
import type { MailWorkerOptions } from '../src/handlers/mail.ts';

/**
 * `fss admin drill seed-evidence`, against a real PostgreSQL (lane g40).
 *
 * The ninth full rehearsal (run 35930664547, 23 September 2026) reached the restore
 * drill for the first time and the drill refused after 67 seconds: the baseline it
 * measured had no sends, no replies, no suppressions and no CRM edits, and
 * `docs/greenfield/restore-drill.md` 0.1 says reconstructing nothing proves nothing.
 * Nothing in the tree could produce any of it in a deployed environment. This is that
 * command, and this file is the proof that it produces all five *through the real
 * paths* rather than through inserts that would make the drill reconstruct rows no
 * domain function ever wrote.
 *
 * ## The vacuous-pass traps, named
 *
 * Three of them.
 *
 *   * "It exits 0." A command that wrote a firm and nothing else would exit 0 and leave
 *     the drill refusing for exactly the same reason. So every case reads
 *     `fss admin counts` back — the same function the drill's baseline reads — and
 *     requires each of the five to be at least one.
 *   * "It is idempotent." A second run that added a second firm and a second send would
 *     also be a run that never refused. So the idempotence case asserts the row counts
 *     did not move, rather than asserting the report said `existing`.
 *   * "It refuses `live`." A refusal that arrived *after* the writes would be a
 *     production database with a seeded firm in it. So the live case asserts the
 *     refusal and that the tables are still empty.
 */

let adminUrl: string;
let databaseName: string;
let databaseUrl: string;
let client: pg.Client;
let session: SessionQueryable;
let reports: string;

const journalled: SuppressionJournalRecord[] = [];

/**
 * The rehearsal's own dependency selection, complete.
 *
 * The same variables `fssSurface.test.ts` uses, with a generated client secret: no
 * credential literal enters this repository, and `recorded` still requires every public
 * identifier a Gmail client needs, so a half-configured deployment is a refusal.
 */
function recordedEnvironment(): Record<string, string | undefined> {
  return {
    FSS_ENVIRONMENT: 'rehearsal',
    FSS_DEPENDENCIES: 'recorded',
    AWS_REGION: 'us-east-1',
    FSS_PUBLIC_ORIGIN: 'https://api.example.test',
    FSS_GMAIL_PUSH_AUDIENCE: 'https://api.example.test/integrations/gmail/push',
    FSS_GMAIL_PUSH_SERVICE_ACCOUNT: 'push@example.iam.gserviceaccount.test',
    FSS_GMAIL_PUSH_TOPIC: 'projects/example/topics/push',
    FSS_GOOGLE_HOSTED_DOMAIN: 'example.test',
    'google-gmail-oauth-client': JSON.stringify({
      client_id: 'example.apps.googleusercontent.test',
      client_secret: `zz-${randomUUID()}-zz`,
    }),
  };
}

/**
 * The deployment's mail composition, with the journal replaced by a recorder.
 *
 * The bucket is the one part of the real composition a test cannot have: the S3 journal
 * is a network call, and `composeHandlers` takes an injected one for exactly this. What
 * is *not* replaced is the envelope cipher or the OAuth configuration — the seed wraps
 * its refresh token with the deployment's own cipher, and a test that substituted one
 * would stop proving that the token it stores is the token the client can use.
 */
async function mailOptions(): Promise<MailWorkerOptions> {
  const deployment = await readWorkerDeployment(recordedEnvironment());
  const composition = await composeHandlers(deployment, undefined, {
    journal: {
      append: async record => {
        journalled.push(record);
        await Promise.resolve();
      },
    },
    region: 'us-east-1',
  });
  const mail = composition.mail;
  if (mail === undefined) throw new Error('the recorded deployment composed no mail client');
  return mail;
}

async function run(
  argv: readonly string[],
  overrides: Record<string, string | undefined> = {},
): Promise<{ readonly code: number; readonly stdout: string }> {
  const printed: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await main(argv, {
      DATABASE_URL: databaseUrl,
      FSS_MIGRATION_DATABASE_URL: databaseUrl,
      ...overrides,
    });
    return { code, stdout: printed.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const countOf = async (table: string, where = 'true', values: readonly unknown[] = []): Promise<number> => {
  const { rows } = await session.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    values,
  );
  return Number(rows[0]?.count ?? '0');
};

beforeAll(async () => {
  adminUrl = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '';
  expect(adminUrl.length, 'the embedded cluster URL is what globalSetup leaves').toBeGreaterThan(0);
  databaseName = `fss_drillev_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  session = asSession(client as never);
  reports = mkdtempSync(join(tmpdir(), 'fss-drill-evidence-'));

  const migrated = await run(['migrate']);
  expect(migrated.code, 'the seed needs a migrated database').toBe(0);
  // g39's command, because the seed refuses without a workspace and an active admin —
  // and because that is the order the release workflow runs them in.
  const bootstrapped = await run([
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
  expect(bootstrapped.code, 'the seed needs the first workspace').toBe(0);
}, 120_000);

afterAll(async () => {
  await client.end().catch(() => undefined);
  const dropper = new pg.Client({ connectionString: adminUrl });
  await dropper.connect();
  try {
    await dropper.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await dropper.end();
  }
});

describe('fss admin drill seed-evidence', () => {
  it('refuses a live deployment before it writes anything at all', async () => {
    const before = await countOf('firms');
    expect(before, 'this case must run against an unseeded database to mean anything').toBe(0);

    const { code } = await run(
      ['admin', 'drill', 'seed-evidence', '--workspace-slug', 'rehearsal', '--phase', 'before'],
      { ...recordedEnvironment(), FSS_DEPENDENCIES: 'live' },
    );
    expect(code).toBe(20);
    // The refusal is the whole guard: production's worker says `live`, production's
    // drill runs against real data, and a seed that wrote first and refused second
    // would have put a fabricated firm in it.
    expect(await countOf('firms')).toBe(0);
    expect(await countOf('outbound_messages')).toBe(0);
    expect(await countOf('suppression_events')).toBe(0);
  });

  it('refuses a workspace slug nothing bootstrapped', async () => {
    const outcome = await seedDrillEvidence({
      session,
      mail: await mailOptions(),
      workspaceSlug: 'no-such-workspace',
      phase: 'before',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'workspace_unknown' });
    expect(await countOf('firms')).toBe(0);
  });

  it('produces all five kinds through the real paths, and reports the counts fss admin counts reads', async () => {
    const outcome = await seedDrillEvidence({
      session,
      mail: await mailOptions(),
      workspaceSlug: 'rehearsal',
      phase: 'before',
    });
    expect(outcome.ok, `the seed refused: ${JSON.stringify(outcome)}`).toBe(true);
    if (!outcome.ok) return;
    const report = outcome.value;

    // Each item names itself and what it made, so a report cannot say "done" about a
    // step that produced nothing.
    const steps = Object.fromEntries(report.items.map(item => [item.step, item]));
    for (const step of [
      'template',
      'sequence',
      'sending_domain',
      // Lane g71: the drill's own release record, which the attestation names.
      'release_record',
      'sending_attestation',
      'mailbox',
      'firm',
      'accepted_send',
      'prospect_reply',
      'prospect_opt_out',
      'opportunity_manual',
      'manual_suppression',
      'late_opt_out_firm',
      'dial_route',
      'calling_identity',
      'administrative_pause',
      'restore_lost_firm',
      'restore_lost_sequence',
      'restore_lost_enrollment',
      'crm_edit',
    ]) {
      expect(steps[step], `the report says nothing about ${step}`).toBeDefined();
      expect(steps[step]?.outcome).toBe('created');
      expect(steps[step]?.id.length, `${step} reported no id`).toBeGreaterThan(0);
    }

    // Lane g59: what the later steps of the drill need to find in the restored copy,
    // each through its own entry point. A usable phone route on an assigned firm, and
    // (lane g60) the assignee's own calling number, attested by its owner through the
    // path a person takes — with who, how and when recorded, and an audit event for
    // each step — rather than an INSERT of a verified row.
    const phones = await session.query<{ eligibility: string }>('SELECT eligibility FROM phone_routes');
    expect(phones.rows).toEqual([{ eligibility: 'usable' }]);
    const identities = await session.query<{
      id: string;
      owner_user_id: string;
      verification_status: string;
      enabled: boolean;
      verified_by_user_id: string;
      verification_method: string;
    }>(
      `SELECT id, owner_user_id, verification_status, enabled, verified_by_user_id, verification_method
         FROM calling_identities`,
    );
    expect(identities.rows).toEqual([
      {
        id: steps['calling_identity']?.id,
        owner_user_id: report.adminUserId,
        verification_status: 'verified',
        enabled: true,
        verified_by_user_id: report.adminUserId,
        verification_method: 'owner_attestation',
      },
    ]);
    expect(await countOf('audit_events', "action IN ('calling_identity.registered', 'calling_identity.attested')")).toBe(2);
    // The route's firm is assigned to the identity's owner: together they are a subject
    // the step 1 dial probe can ask about.
    expect(
      await countOf(
        'firms f JOIN phone_routes r ON r.firm_id = f.id JOIN calling_identities i ON i.owner_user_id = f.assigned_user_id',
        "r.eligibility = 'usable' AND i.enabled",
      ),
    ).toBe(1);
    // An administrative pause, which step 9 has to leave in force (4.3).
    expect(
      await countOf('active_holds', "reason_code = 'scoped_pause' AND released_at IS NULL"),
      'the seed opened no administrative pause',
    ).toBe(1);
    // The sending domain came through lane g57's creator, not an INSERT of the seed's own.
    expect(await countOf('audit_events', "action = 'sending_domain.registered'")).toBe(1);
    // The recording: the accepted send is in the Sent folder, the two inbound messages
    // are what the phase delivered, and the admin is named for step 9.
    const sentHeader = (
      await session.query<{ header: string }>(
        "SELECT provider_message_id_header AS header FROM outbound_messages WHERE state = 'sent'",
      )
    ).rows[0]?.header;
    expect(report.mailbox.sentMessageIds).toEqual([sentHeader]);
    // Lane g73: the same send as the Sent folder lists it — the metadata step 3 reads.
    expect(report.mailbox.sentMessages).toHaveLength(1);
    expect(report.mailbox.sentMessages[0]).toMatchObject({
      labelIds: ['SENT'],
      headers: { 'Message-ID': sentHeader, To: 'primary@drill-evidence.invalid' },
    });
    // And the enrollment whose step the after phase sends: pending, due a month out so
    // no rehearsal worker prepares it first, and with no fence.
    const lostStep = await session.query<{ state: string; due_in_days: number; fences: string }>(
      `SELECT e.state, extract(day FROM e.due_at - now())::int AS due_in_days,
              (SELECT count(*) FROM outbound_messages o WHERE o.step_execution_id = e.id)::text AS fences
         FROM step_executions e WHERE e.id = $1`,
      [steps['restore_lost_enrollment']?.id],
    );
    expect(lostStep.rows).toEqual([{ state: 'pending', due_in_days: 29, fences: '0' }]);
    expect(report.mailbox.messages.map(message => message.id).sort()).toEqual([
      'fss-drill-evidence-opt-out-1',
      'fss-drill-evidence-reply-1',
    ]);
    expect(report.adminUserId).toMatch(/^[0-9a-f-]{36}$/u);

    // ---- the five kinds, read from the tables rather than from the report ----
    //
    // An accepted send is a fence the real dispatch path drove to `sent`, so the
    // provider ids and the ledger are there too: a row inserted to satisfy a count
    // would have neither.
    const fences = await session.query<{ state: string; provider_message_id: string | null }>(
      'SELECT state, provider_message_id FROM outbound_messages',
    );
    expect(fences.rows).toHaveLength(1);
    expect(fences.rows[0]?.state).toBe('sent');
    expect(fences.rows[0]?.provider_message_id).not.toBeNull();
    expect(await countOf('outbound_message_events')).toBe(3);

    // A reply, with the effect the counting code recognises as one (12.3, 12.4).
    const effects = await session.query<{ effect_kind: string }>('SELECT effect_kind FROM mail_message_effects');
    const kinds = effects.rows.map(row => row.effect_kind);
    expect(kinds).toContain('reply_lane_entry');
    expect(kinds).toContain('handle_suppressed');
    expect(kinds).toContain('firm_suppressed');

    // The opportunity the confirmed reply set manual, which 0.1 asks for by name.
    const manualModes = await session.query<{ control_mode: string }>(
      "SELECT control_mode FROM opportunities WHERE control_mode = 'manual'",
    );
    expect(manualModes.rows.length).toBeGreaterThanOrEqual(1);

    // Two suppressions from the prospect's opt-out (the handle and its unambiguous
    // firm) and one from the salesperson, and every one of them journalled *before*
    // its row (10.2) — which is what makes the drill's step 2 replay possible at all.
    const sources = await session.query<{ source: string; count: string }>(
      'SELECT source, count(*)::text AS count FROM suppression_events GROUP BY source ORDER BY source',
    );
    expect(Object.fromEntries(sources.rows.map(row => [row.source, Number(row.count)]))).toEqual({
      prospect_opt_out: 2,
      salesperson_manual: 1,
    });
    expect(journalled.length).toBe(3);
    expect(journalled.map(record => record.source).sort()).toEqual([
      'prospect_opt_out',
      'prospect_opt_out',
      'salesperson_manual',
    ]);

    // The salesperson's own suppression is inside its ten-minute correction window,
    // which is the state 0.1 asks the drill to find it in.
    const window = await session.query<{ open: boolean }>(
      `SELECT (now() - recorded_at) < interval '10 minutes' AS open
         FROM suppression_events WHERE source = 'salesperson_manual'`,
    );
    expect(window.rows[0]?.open).toBe(true);

    // An ordinary CRM edit with no protected effect: one `firm.updated` audit row, no
    // domain event, no hold.
    const edits = await session.query<{ action: string }>(
      "SELECT action FROM audit_events WHERE action = 'firm.updated'",
    );
    expect(edits.rows).toHaveLength(1);

    // ---- and the counts, from the code `fss admin counts` calls ----
    for (const kind of ['sends', 'replies', 'suppressions', 'crm_edits', 'migrations'] as const) {
      expect(report[kind], `the seed reported no ${kind}`).toBeGreaterThanOrEqual(1);
    }
    expect(Date.parse(report.asOf), 'the report carries the instant the drill waits past').not.toBeNaN();

    const counts = await run(['admin', 'counts', '--report', join(reports, 'counts.json')]);
    expect(counts.code).toBe(0);
    const measured = JSON.parse(readFileSync(join(reports, 'counts.json'), 'utf8')) as Record<string, number>;
    for (const kind of ['sends', 'replies', 'suppressions', 'crm_edits', 'migrations'] as const) {
      // The refusal the drill makes is `< 1`, so this is that refusal's positive control.
      expect(measured[kind], `fss admin counts reports no ${kind}`).toBeGreaterThanOrEqual(1);
    }
  }, 120_000);

  it('is idempotent: a second run of the same phase adds no firm, no send and no suppression', async () => {
    const before = {
      firms: await countOf('firms'),
      sends: await countOf('outbound_messages'),
      suppressions: await countOf('suppression_events'),
      messages: await countOf('mail_messages'),
      edits: await countOf('audit_events', "action = 'firm.updated'"),
      attestations: await countOf('audit_events', "action = 'calling_identity.attested'"),
    };
    expect(before.firms, 'the idempotence case needs the first run to have happened').toBeGreaterThan(0);
    const appended = journalled.length;

    const outcome = await seedDrillEvidence({
      session,
      mail: await mailOptions(),
      workspaceSlug: 'rehearsal',
      phase: 'before',
    });
    expect(outcome.ok, `the second run refused: ${JSON.stringify(outcome)}`).toBe(true);
    if (!outcome.ok) return;
    for (const item of outcome.value.items) {
      expect(item.outcome, `${item.step} was created twice`).toBe('existing');
    }

    expect(await countOf('firms')).toBe(before.firms);
    expect(await countOf('outbound_messages')).toBe(before.sends);
    expect(await countOf('suppression_events')).toBe(before.suppressions);
    expect(await countOf('mail_messages')).toBe(before.messages);
    expect(await countOf('audit_events', "action = 'firm.updated'")).toBe(before.edits);
    // The calling number is attested once, however many times the seed runs (lane g60).
    expect(await countOf('calling_identities')).toBe(1);
    expect(await countOf('audit_events', "action = 'calling_identity.attested'")).toBe(before.attestations);
    // `recordSuppression` writes the journal before the row and the event id is
    // deterministic, so a replay appends the same object rather than a second one.
    expect(journalled.length - appended).toBeLessThanOrEqual(1);
  }, 120_000);

  /**
   * Lane g59: the send left in doubt at the restore target, for Appendix E step 3.
   *
   * The trap: a fence that reached `sent`, or one that was *set* to `reconciling`,
   * would give step 3 nothing to prove or a row no dispatch ever wrote. So the fence is
   * read back in `reconciling` with its `send_unknown_reconciling` hold, through the
   * ledger the dispatch path writes, and its Message-ID is in the phase's recorded Sent
   * folder — which is what step 3 searches.
   */
  it('the in-flight phase leaves one delivered send in doubt, and records its Message-ID as sent', async () => {
    const before = {
      sent: await countOf('outbound_messages', "state = 'sent'"),
      suppressions: await countOf('suppression_events'),
      edits: await countOf('audit_events', "action = 'firm.updated'"),
    };
    const outcome = await seedDrillEvidence({
      session,
      mail: await mailOptions(),
      workspaceSlug: 'rehearsal',
      phase: 'in-flight',
    });
    expect(outcome.ok, `the in-flight phase refused: ${JSON.stringify(outcome)}`).toBe(true);
    if (!outcome.ok) return;
    const steps = Object.fromEntries(outcome.value.items.map(item => [item.step, item.outcome]));
    expect(steps['in_doubt_send']).toBe('created');
    expect(steps['accepted_send']).toBeUndefined();
    expect(steps['crm_edit']).toBeUndefined();

    const doubt = await session.query<{ id: string; header: string }>(
      "SELECT id, provider_message_id_header AS header FROM outbound_messages WHERE state = 'reconciling'",
    );
    expect(doubt.rows).toHaveLength(1);
    const ledger = await session.query<{ to_state: string }>(
      'SELECT to_state FROM outbound_message_events WHERE outbound_message_id = $1 ORDER BY occurred_at, id',
      [doubt.rows[0]?.id],
    );
    expect(ledger.rows.map(row => row.to_state)).toContain('reconciling');
    expect(
      await countOf('active_holds', "reason_code = 'send_unknown_reconciling' AND released_at IS NULL"),
    ).toBe(1);
    expect(outcome.value.mailbox.sentMessageIds).toEqual([doubt.rows[0]?.header]);
    expect(outcome.value.mailbox.sentMessages.map(message => message.headers['Message-ID'])).toEqual([doubt.rows[0]?.header]);
    expect(outcome.value.mailbox.messages).toEqual([]);
    // Nothing else moved: no send reached `sent`, no suppression, no edit.
    expect(await countOf('outbound_messages', "state = 'sent'")).toBe(before.sent);
    expect(await countOf('suppression_events')).toBe(before.suppressions);
    expect(await countOf('audit_events', "action = 'firm.updated'")).toBe(before.edits);

    // Idempotent, and the recording is the same on the re-run.
    const again = await seedDrillEvidence({ session, mail: await mailOptions(), workspaceSlug: 'rehearsal', phase: 'in-flight' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.items.every(item => item.outcome === 'existing')).toBe(true);
    expect(await countOf('outbound_messages', "state = 'reconciling'")).toBe(1);
    expect(again.value.mailbox.sentMessageIds).toEqual(outcome.value.mailbox.sentMessageIds);
  }, 120_000);

  it('the after phase adds a second send, a second CRM edit and the prospect opt-out the restore loses', async () => {
    // Lane g77: in a rehearsal the after phase runs half an hour after the before phase,
    // and the mailbox's coverage was last proved then. The send gate holds a mailbox
    // whose proof is older than its freshness window, so the phase has to prove it
    // again before its send — this is that half hour, applied to the row.
    await session.query("UPDATE mailboxes SET coverage_watermark_at = now() - interval '45 minutes'");
    const before = {
      sends: await countOf('outbound_messages', "state = 'sent'"),
      suppressions: await countOf('suppression_events'),
      edits: await countOf('audit_events', "action = 'firm.updated'"),
      journalled: journalled.length,
    };

    const outcome = await seedDrillEvidence({
      session,
      mail: await mailOptions(),
      workspaceSlug: 'rehearsal',
      phase: 'after',
    });
    expect(outcome.ok, `the after phase refused: ${JSON.stringify(outcome)}`).toBe(true);
    if (!outcome.ok) return;
    const steps = Object.fromEntries(outcome.value.items.map(item => [item.step, item.outcome]));
    expect(steps['accepted_send']).toBe('created');
    // Lane g73: the send of the step the before phase enrolled, whose fence the restore
    // loses while its step survives.
    expect(steps['restore_lost_send']).toBe('created');
    expect(steps['crm_edit']).toBe('created');
    // 0.1's "let the clock run past it while more activity happens", and lane g59's
    // correction of what that activity has to be: steps 2 and 4 reconstruct what the
    // restore *lost*, so the after phase journals a prospect's opt-out, from a firm the
    // before phase made so the restored copy can match it. No second reply: an
    // uncertain reply recovered by step 4 would hold an opportunity nobody confirms,
    // and step 9 rightly refuses to advance past an unresolved one.
    expect(steps['late_opt_out']).toBe('created');
    expect(steps['late_opt_out_firm']).toBe('existing');
    expect(steps['prospect_reply']).toBeUndefined();
    expect(steps['manual_suppression']).toBeUndefined();

    expect(await countOf('outbound_messages', "state = 'sent'")).toBe(before.sends + 2);
    expect(
      await countOf('outbound_messages', "state = 'sent' AND recipient_address = 'restore-lost@drill-evidence.invalid'"),
    ).toBe(1);
    expect(await countOf('mailboxes', "coverage_watermark_at > now() - interval '5 minutes'")).toBe(1);
    expect(await countOf('audit_events', "action = 'firm.updated'")).toBe(before.edits + 1);
    // The handle and its one unambiguous firm, each journalled before its row.
    expect(await countOf('suppression_events')).toBe(before.suppressions + 2);
    expect(journalled.length - before.journalled).toBe(2);
    expect(
      journalled.slice(before.journalled).map(record => [record.scope, record.source]).sort(),
    ).toEqual([
      ['firm', 'prospect_opt_out'],
      ['handle', 'prospect_opt_out'],
    ]);
    // The command id is the message as Gmail knows it, not its row id, so a recovery
    // after a restore reaches the same event id (packages/domain/mail/effects.ts).
    expect(journalled.slice(before.journalled).every(record => record.commandId?.includes('fss-drill-evidence-opt-out-2'))).toBe(true);

    // The recording: the after send in the Sent folder, and the opt-out dated now rather
    // than at the send clock's nine in the morning, so step 4's window contains it.
    expect(outcome.value.mailbox.sentMessageIds).toHaveLength(2);
    expect(outcome.value.mailbox.sentMessages.map(message => message.headers['To']).sort()).toEqual([
      'after@drill-evidence.invalid',
      'restore-lost@drill-evidence.invalid',
    ]);
    const [late] = outcome.value.mailbox.messages;
    expect(late?.id).toBe('fss-drill-evidence-opt-out-2');
    expect(Math.abs((late?.internalDateEpochMilliseconds ?? 0) - Date.now())).toBeLessThan(120_000);

    // Idempotent: a re-run adds no send, no edit, no suppression, and records the same.
    const again = await seedDrillEvidence({ session, mail: await mailOptions(), workspaceSlug: 'rehearsal', phase: 'after' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.items.every(item => item.outcome === 'existing'), JSON.stringify(again.value.items)).toBe(true);
    expect(await countOf('suppression_events')).toBe(before.suppressions + 2);
    expect(await countOf('outbound_messages', "state = 'sent'")).toBe(before.sends + 2);
    expect(again.value.mailbox).toEqual(outcome.value.mailbox);
  }, 120_000);
});

describe('the clock the send gate is given', () => {
  it('is always a weekday inside 11.2’s email window, so a Sunday rehearsal still sends', () => {
    for (const day of ['2026-09-20T02:00:00Z', '2026-09-19T23:30:00Z', '2026-09-23T18:00:00Z']) {
      const at = windowInstant(new Date(day));
      expect(at.getUTCDay(), `${day} snapped to a weekend`).toBeGreaterThanOrEqual(1);
      expect(at.getUTCDay()).toBeLessThanOrEqual(5);
      expect(at.getUTCHours()).toBe(9);
      // Never later than the instant it was derived from: a fence placed in the future
      // is a fence whose business date has not started.
      expect(at.getTime()).toBeLessThanOrEqual(Date.parse(day));
    }
  });
});
