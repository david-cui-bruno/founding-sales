import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import { asSession, CLUSTER_URL_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { createOutboundWorld, type OutboundWorld } from '../../../packages/domain/test/outbound/support/outboundWorld.ts';
import {
  mailboxSwitchPreflightCommand,
  sendPathPreviewCommand,
  type AdminInvocation,
  type AdminOutcome,
} from '../src/tools/fss/admin.ts';
import { COMMAND_DEPENDENCIES, parseFssCommand } from '../src/tools/fss/commands.ts';
import { readToolConfig } from '../src/tools/fss/config.ts';

/**
 * The mailbox switch's two read-only commands (call-to-booking A2):
 * `fss admin mailbox switch-preflight` and `fss admin send-path preview`, on the
 * outbound world — a connected, covered, attested mailbox with a prepared fence — plus a
 * due prospecting e-mail step.
 *
 * "Reads only" is measured: `pg_stat_user_tables` counts every tuple written by the
 * session that runs the command, committed or not, and the same measurement is shown to
 * move for a write (the vacuous-pass trap `fssSendPathReport.test.ts` names).
 */

let world: OutboundWorld;
let url = '';
let fenceId = '';
let dueStepId = '';

const workspaceId = (): string => world.alpha.workspace.workspaceId;

function invocation(session: SessionQueryable, options: Record<string, string>): AdminInvocation {
  return {
    session,
    config: readToolConfig({ DATABASE_URL: url }),
    environment: {},
    options,
    switches: new Set<string>(),
  };
}

function reportOf(outcome: AdminOutcome): Record<string, unknown> {
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason} ${outcome.detail}`);
  return outcome.value['report'] as Record<string, unknown>;
}

beforeAll(async () => {
  world = await createOutboundWorld();
  const clusterUrl = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  clusterUrl.pathname = `/${world.database.name}`;
  url = clusterUrl.toString();
  fenceId = await world.prepare(world.alpha);
  dueStepId = await makeStepExecution(world.database.session, {
    workspaceId: workspaceId(),
    firmId: world.crm.alpha.firmId,
    opportunityId: world.crm.alpha.opportunityId,
    userId: world.alpha.workspace.salesperson.userId,
    templateVersionId: world.alpha.templateVersionId,
    originKind: 'prospecting',
  });
  await world.database.session.query(
    `UPDATE step_executions SET due_at = now() - interval '1 hour', not_before = now() - interval '1 hour'
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId(), dueStepId],
  );
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

describe('the command grammar', () => {
  it('registers both, database-only', () => {
    expect(COMMAND_DEPENDENCIES['mailbox switch-preflight']).toBe('database');
    expect(COMMAND_DEPENDENCIES['send-path preview']).toBe('database');
    expect(parseFssCommand(['admin', 'mailbox', 'switch-preflight', '--workspace', 'w', '--mailbox', 'm']).ok).toBe(true);
    expect(parseFssCommand(['admin', 'send-path', 'preview', '--workspace', 'w', '--sample', '5']).ok).toBe(true);
    expect(parseFssCommand(['admin', 'send-path', 'preview', '--mailbox', 'm'])).toMatchObject({ ok: false, reason: 'flag_unknown' });
  });
});

describe('fss admin mailbox switch-preflight', () => {
  it('reports the mailbox and what references it, and would refuse while a fence is pending and the sync is stale', async () => {
    const report = reportOf(await mailboxSwitchPreflightCommand(invocation(world.database.session, { '--workspace': workspaceId() })));
    expect(Object.keys(report).sort()).toEqual(
      [
        'accounts',
        'fences',
        'liveEnrollments',
        'liveFollowUpPermissions',
        'mailJobs',
        'mailbox',
        'messages',
        'openHolds',
        'readAt',
        'sendDays',
        'watches',
        'workspaceId',
        'wouldRefuse',
      ].sort(),
    );
    expect(report['mailbox']).toMatchObject({
      id: world.alpha.mailboxId,
      address: world.alpha.address,
      status: 'connected',
      syncState: 'ready',
    });
    expect(report['fences']).toMatchObject({
      byState: [{ state: 'prepared', count: 1 }],
      nonTerminal: [{ id: fenceId, state: 'prepared' }],
    });
    expect(report['accounts']).toEqual([]);
    expect(report['liveEnrollments']).toEqual(
      expect.arrayContaining([expect.objectContaining({ originKind: 'prospecting', count: 1 })]) as unknown,
    );
    expect(report['wouldRefuse']).toEqual(['old_account_not_synced_within_2_minutes', 'non_terminal_fences']);
  });

  it('drops the sync condition once the old account synced within two minutes', async () => {
    const synced = async (at: string | null): Promise<void> => {
      await world.database.session.query('UPDATE mailboxes SET last_synced_at = $3 WHERE workspace_id = $1 AND id = $2', [
        workspaceId(),
        world.alpha.mailboxId,
        at,
      ]);
    };
    await synced(new Date().toISOString());
    try {
      const report = reportOf(await mailboxSwitchPreflightCommand(invocation(world.database.session, { '--workspace': workspaceId() })));
      expect(report['wouldRefuse']).toEqual(['non_terminal_fences']);
    } finally {
      await synced(null);
    }
  });

  it('reads mail jobs in both key formats and reports the pre-generation ones as orphaned', async () => {
    const id = world.alpha.mailboxId;
    const job = async (kind: string, key: string, state: string): Promise<void> => {
      await world.database.session.query(
        `INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state, dead_at)
         VALUES ($1, $2, jsonb_build_object('mailboxId', $3::text), $4, $5, CASE WHEN $5 = 'dead' THEN now() END)
         ON CONFLICT (workspace_id, kind, idempotency_key)
         DO UPDATE SET state = EXCLUDED.state, dead_at = EXCLUDED.dead_at`,
        [workspaceId(), kind, id, key, state],
      );
    };
    const count = async (kind: string, keyFormat: string, state: 'queued' | 'dead'): Promise<number> => {
      const report = reportOf(await mailboxSwitchPreflightCommand(invocation(world.database.session, { '--workspace': workspaceId() })));
      const row = (report['mailJobs'] as readonly Record<string, unknown>[]).find(
        entry => entry['kind'] === kind && entry['keyFormat'] === keyFormat,
      );
      return Number(row?.[state] ?? 0);
    };
    const syncQueuedBefore = await count('mail.sync', 'current', 'queued');
    const watchDeadBefore = await count('mail.watch_renew', 'current', 'dead');
    await job('mail.sync', `mail-sync:${id}`, 'dead');
    await job('mail.sync', `mail-sync:${id}:7`, 'queued');
    await job('mail.watch_renew', `watch:${id}:3`, 'queued');
    await job('mail.watch_renew', `watch:${id}:7:4`, 'dead');
    expect(await count('mail.sync', 'orphaned_pre_generation', 'dead')).toBe(1);
    expect(await count('mail.sync', 'current', 'queued')).toBe(syncQueuedBefore + 1);
    expect(await count('mail.watch_renew', 'orphaned_pre_generation', 'queued')).toBe(1);
    expect(await count('mail.watch_renew', 'current', 'dead')).toBe(watchDeadBefore + 1);
  });

  it('refuses rather than pick a workspace', async () => {
    const outcome = await mailboxSwitchPreflightCommand(invocation(world.database.session, {}));
    expect(outcome).toMatchObject({ ok: false, reason: 'workspace_ambiguous' });
  });
});

describe('fss admin send-path preview', () => {
  const CONDITIONS = [
    'cap',
    'coldOutreach',
    'domainSwitch',
    'holds',
    'mailboxCoverage',
    'permission',
    'sendingWindow',
    'suppression',
    'workspaceAttestation',
  ];

  it('evaluates every condition for the prepared fence and the due step, and names the sender', async () => {
    const report = reportOf(await sendPathPreviewCommand(invocation(world.database.session, { '--workspace': workspaceId() })));
    const fences = report['fences'] as readonly Record<string, unknown>[];
    expect(fences.map(fence => fence['outboundMessageId'])).toEqual([fenceId]);
    const fence = fences[0] ?? {};
    expect(fence['resolvedSender']).toBe(world.alpha.address);
    const conditions = fence['conditions'] as Record<string, { pass: boolean; reason: string | null }>;
    expect(Object.keys(conditions).sort()).toEqual(CONDITIONS);
    expect(conditions['domainSwitch']).toEqual({ pass: true, reason: null });
    expect(conditions['workspaceAttestation']).toEqual({ pass: true, reason: null });
    expect(conditions['suppression']).toEqual({ pass: true, reason: null });

    const steps = report['dueEmailSteps'] as readonly Record<string, unknown>[];
    const step = steps.find(entry => entry['stepExecutionId'] === dueStepId);
    expect(step?.['resolvedSender']).toBe(world.alpha.address);
    expect(step?.['originKind']).toBe('prospecting');
    const stepConditions = step?.['conditions'] as Record<string, { pass: boolean; reason: string | null }>;
    expect(Object.keys(stepConditions).sort()).toEqual(CONDITIONS);
    expect(stepConditions['coldOutreach']).toEqual({ pass: false, reason: 'cold_outreach_mailbox_required' });
  });

  it('keeps evaluating the rest when the domain switch is off, which is where the gate stops', async () => {
    await world.database.session.query(
      'UPDATE sending_domains SET automated_sending_enabled = false, automated_sending_enabled_at = NULL WHERE workspace_id = $1',
      [workspaceId()],
    );
    try {
      const report = reportOf(await sendPathPreviewCommand(invocation(world.database.session, { '--workspace': workspaceId() })));
      const fence = (report['fences'] as readonly Record<string, unknown>[])[0] ?? {};
      const conditions = fence['conditions'] as Record<string, { pass: boolean; reason: string | null }>;
      expect(conditions['domainSwitch']).toEqual({ pass: false, reason: 'automated_sending_disabled' });
      // Still asked, each on its own.
      expect(conditions['suppression']).toEqual({ pass: true, reason: null });
      expect(conditions['workspaceAttestation']).toEqual({ pass: true, reason: null });
      expect(conditions['cap']).toEqual({ pass: true, reason: null });
    } finally {
      await world.database.session.query(
        'UPDATE sending_domains SET automated_sending_enabled = true, automated_sending_enabled_at = now() WHERE workspace_id = $1',
        [workspaceId()],
      );
    }
  });

  // Last in this block: the opt-out stays (suppression events are insert-only).
  it('reports a suppressed recipient as failing suppression, and the domain switch still on its own', async () => {
    const { rows } = await world.database.session.query<{ recipient_address: string }>(
      'SELECT recipient_address FROM outbound_messages WHERE workspace_id = $1 AND id = $2',
      [workspaceId(), fenceId],
    );
    await world.database.session.query(
      `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source)
       VALUES ($1, 'preview-optout', 'handle', $2, 'v1', 'prospect_opt_out')`,
      [workspaceId(), rows[0]?.recipient_address ?? ''],
    );
    const report = reportOf(await sendPathPreviewCommand(invocation(world.database.session, { '--workspace': workspaceId() })));
    const fence = (report['fences'] as readonly Record<string, unknown>[])[0] ?? {};
    const conditions = fence['conditions'] as Record<string, { pass: boolean; reason: string | null }>;
    expect(conditions['suppression']).toEqual({ pass: false, reason: 'handle_suppressed' });
    expect(conditions['domainSwitch']).toEqual({ pass: true, reason: null });
  });
});

describe('neither command writes', () => {
  it('leaves the mutation counters where they were, and the counters move for a write', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const session: SessionQueryable = asSession(client as never);
    const counters = async (): Promise<number> => {
      await session.query('SELECT pg_stat_force_next_flush()');
      const { rows } = await session.query<{ total: string }>(
        'SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text AS total FROM pg_stat_user_tables',
      );
      return Number(rows[0]?.total ?? '0');
    };
    try {
      const before = await counters();
      expect((await mailboxSwitchPreflightCommand(invocation(session, { '--workspace': workspaceId() }))).ok).toBe(true);
      expect((await sendPathPreviewCommand(invocation(session, { '--workspace': workspaceId() }))).ok).toBe(true);
      expect(await counters(), 'both commands are READ ONLY transactions').toBe(before);

      await session.query('BEGIN');
      await session.query('UPDATE mailboxes SET updated_at = updated_at WHERE workspace_id = $1', [workspaceId()]);
      await session.query('ROLLBACK');
      expect(await counters()).toBeGreaterThan(before);
    } finally {
      await client.end().catch(() => undefined);
    }
  });
});
