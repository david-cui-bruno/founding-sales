import { upsertTodayItem } from '@fss/domain/today/snapshots.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { z } from 'zod';
import { explicitOpportunityResultSchema, pluralFirmPageResponseSchema, pluralPipelineBoardResponseSchema } from '@fss/contracts';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';

it('versioned commands expose distinct deals and old singleton reads refuse ambiguity', async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const firmId = await seedFirm(fixture, {
      name: 'Parallel explicit pilots',
      regionCode: 'TX',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const post = async (path: string, body: unknown) =>
      dispatch(
        { method: 'POST', path, body, headers: { authorization: `Bearer ${token}` }, query: new URLSearchParams() },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
          upgradeUrl: 'https://callie.example/downloads/mac',
          suppressionJournal: localNoopSuppressionJournal(),
        },
      );
    const accepted = z.strictObject({ status: z.literal('accepted'), replayed: z.boolean(), result: explicitOpportunityResultSchema });
    const firstPayload = { firmId, name: 'First pilot', commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION };
    const first = accepted.parse((await post('/opportunities/v2/open', firstPayload)).body);
    const replay = accepted.parse((await post('/opportunities/v2/open', firstPayload)).body);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    const second = accepted.parse(
      (
        await post('/opportunities/v2/open', {
          firmId,
          name: 'Second initiative',
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
        })
      ).body,
    );
    expect(second.result.opportunityId).not.toBe(first.result.opportunityId);
    const board = await post('/pipeline/board-v2', {});
    expect(board.status, JSON.stringify(board.body)).toBe(200);
    expect(Object.keys(pluralPipelineBoardResponseSchema.parse(board.body).cards)).toHaveLength(2);
    const page = await post('/crm/firm-page-v3', { firmId, pageVersion: 2 });
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    const plural = pluralFirmPageResponseSchema.parse(page.body);
    if (plural.visibility !== 'assigned_or_admin') throw Error('fixture');
    expect(plural.opportunities).toHaveLength(2);
    expect(plural.opportunities.map((entry) => entry.stageControlMode)).toEqual(['human', 'human']);
    expect((await post('/crm/firm-page', { firmId, pageVersion: 2 })).body).toMatchObject({ reason: 'opportunity_ambiguous' });
    expect((await post('/pipeline/board', {})).body).toMatchObject({ reason: 'opportunity_ambiguous' });
    expect(
      (
        await post('/opportunities/stage', {
          opportunityId: first.result.opportunityId,
          toStageKey: 'lost',
          expectedStageKey: 'new',
          reason: 'First pilot ended',
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
        })
      ).status,
    ).toBe(200);
    const reopened = accepted.parse(
      (
        await post('/opportunities/v2/reopen', {
          firmId,
          opportunityId: first.result.opportunityId,
          reason: 'Fresh pilot',
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
        })
      ).body,
    );
    expect(reopened.result.opportunityId).not.toBe(first.result.opportunityId);
    const after = pluralFirmPageResponseSchema.parse((await post('/crm/firm-page-v3', { firmId, pageVersion: 2 })).body);
    if (after.visibility !== 'assigned_or_admin') throw Error('fixture');
    expect(
      after.opportunities.map((entry) => ({ id: entry.opportunity.id, status: entry.opportunity.status, name: entry.displayName })),
    ).toEqual(
      expect.arrayContaining([
        { id: first.result.opportunityId, status: 'lost', name: 'First pilot' },
        { id: second.result.opportunityId, status: 'open', name: 'Second initiative' },
        { id: reopened.result.opportunityId, status: 'open', name: 'First pilot' },
      ]),
    );
  } finally {
    await fixture.stop();
  }
});

it.each(['known', 'unresolved'])(
  'logging a callback preserves %s context and refuses another selected deal before writing',
  async (mode) => {
    const fixture = await createAuthFixture();
    try {
      const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
      const firmId = await seedFirm(fixture, {
        name: 'Callback context',
        regionCode: 'TX',
        assignedUserId: fixture.alpha.salesperson.userId,
      });
      const post = async (path: string, body: unknown) =>
        dispatch(
          { method: 'POST', path, body, headers: { authorization: `Bearer ${token}` }, query: new URLSearchParams() },
          {
            session: fixture.db,
            auth: fixture.deps,
            supportedClientVersions: fixture.deps.config.supportedClientVersions,
            sendingEnabled: false,
            upgradeUrl: 'https://callie.example/downloads/mac',
            suppressionJournal: localNoopSuppressionJournal(),
          },
        );
      const command = (body: Record<string, unknown>) => ({ ...body, commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION });
      const receipt = z.object({ status: z.literal('accepted'), result: explicitOpportunityResultSchema });
      const a = receipt.parse((await post('/opportunities/v2/open', command({ firmId }))).body).result.opportunityId;
      const b = receipt.parse((await post('/opportunities/v2/open', command({ firmId }))).body).result.opportunityId;
      if (mode === 'unresolved')
        expect(
          (
            await post(
              '/opportunities/stage',
              command({ opportunityId: b, toStageKey: 'lost', expectedStageKey: 'new', reason: 'Other initiative ended' }),
            )
          ).status,
        ).toBe(200);
      const callback = (
        await fixture.db.query<{ id: string }>(
          `INSERT INTO callbacks(workspace_id,firm_id,opportunity_id,assigned_user_id,requested_local_date,source_time_zone,due_at,confirmed_at,confirmed_by_user_id) VALUES($1,$2,$3,$4,current_date,'America/New_York',now()+interval '1 hour',now(),$4) RETURNING id`,
          [fixture.alpha.workspaceId, firmId, mode === 'known' ? a : null, fixture.alpha.salesperson.userId],
        )
      ).rows[0]!;
      const context = repositoryContext(
        workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }),
        fixture.db,
      );
      const itemId = await upsertTodayItem(context, {
        businessDate: '2026-10-09',
        firmId,
        itemKey: `callback:${callback.id}`,
        kind: 'callback',
        dueAt: '2026-10-10T14:00:00Z',
        sourceKind: 'callback',
        sourceId: callback.id,
      });
      const before = (await fixture.db.query('SELECT id FROM call_logs WHERE workspace_id=$1', [fixture.alpha.workspaceId])).rows.length;
      const conflict = await post('/calls/log', command({ firmId, itemId, opportunityId: mode === 'known' ? b : a, outcome: 'no_answer' }));
      expect(conflict.body).toMatchObject({ status: 'refused', reason: 'invalid_input' });
      expect((await fixture.db.query('SELECT id FROM call_logs WHERE workspace_id=$1', [fixture.alpha.workspaceId])).rows).toHaveLength(
        before,
      );
      const logged = await post(
        '/calls/log',
        command({
          firmId,
          itemId,
          outcome: 'callback_requested',
          callback: { localDate: '2026-10-12', localTime: '10:00', sourceTimeZone: 'America/New_York', dueAt: '2026-10-12T14:00:00Z' },
        }),
      );
      expect(logged.status, JSON.stringify(logged.body)).toBe(200);
      const result = z
        .object({ result: z.object({ callLogId: z.string().uuid(), callbackId: z.string().uuid() }) })
        .parse(logged.body).result;
      expect(
        (
          await fixture.db.query('SELECT opportunity_id FROM call_logs WHERE workspace_id=$1 AND id=$2', [
            fixture.alpha.workspaceId,
            result.callLogId,
          ])
        ).rows[0],
      ).toEqual({ opportunity_id: mode === 'known' ? a : null });
      expect(
        (
          await fixture.db.query('SELECT opportunity_id FROM callbacks WHERE workspace_id=$1 AND id=$2', [
            fixture.alpha.workspaceId,
            result.callbackId,
          ])
        ).rows[0],
      ).toEqual({ opportunity_id: mode === 'known' ? a : null });
    } finally {
      await fixture.stop();
    }
  },
);

it.each(['known', 'unresolved'])('callback-time Today work preserves %s originating call context without fallback', async (mode) => {
  const fixture = await createAuthFixture();
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const firmId = await seedFirm(fixture, {
      name: 'Callback time context',
      regionCode: 'TX',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const post = async (path: string, body: unknown) =>
      dispatch(
        { method: 'POST', path, body, headers: { authorization: `Bearer ${token}` }, query: new URLSearchParams() },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
          upgradeUrl: 'https://callie.example/downloads/mac',
          suppressionJournal: localNoopSuppressionJournal(),
        },
      );
    const command = (body: Record<string, unknown>) => ({ ...body, commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION });
    const receipt = z.object({ status: z.literal('accepted'), result: explicitOpportunityResultSchema });
    const a = receipt.parse((await post('/opportunities/v2/open', command({ firmId }))).body).result.opportunityId;
    const b = receipt.parse((await post('/opportunities/v2/open', command({ firmId }))).body).result.opportunityId;
    const first = await post(
      '/calls/log',
      command({ firmId, outcome: 'callback_requested', ...(mode === 'known' ? { opportunityId: a } : {}) }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const original = z.object({ result: z.object({ callLogId: z.string().uuid() }) }).parse(first.body).result.callLogId;
    if (mode === 'unresolved')
      expect(
        (
          await post(
            '/opportunities/stage',
            command({ opportunityId: b, toStageKey: 'lost', expectedStageKey: 'new', reason: 'Other initiative ended' }),
          )
        ).status,
      ).toBe(200);
    const item = (
      await fixture.db.query<{ id: string }>('SELECT id FROM today_items WHERE workspace_id=$1 AND item_key=$2', [
        fixture.alpha.workspaceId,
        `callback-time:${original}`,
      ])
    ).rows[0]!;
    const before = (await fixture.db.query('SELECT id FROM call_logs WHERE workspace_id=$1', [fixture.alpha.workspaceId])).rows.length;
    const conflict = await post(
      '/calls/log',
      command({ firmId, itemId: item.id, opportunityId: mode === 'known' ? b : a, outcome: 'no_answer' }),
    );
    expect(conflict.body).toMatchObject({ status: 'refused', reason: 'invalid_input' });
    expect((await fixture.db.query('SELECT id FROM call_logs WHERE workspace_id=$1', [fixture.alpha.workspaceId])).rows).toHaveLength(
      before,
    );
    const logged = await post(
      '/calls/log',
      command({
        firmId,
        itemId: item.id,
        outcome: 'callback_requested',
        callback: { localDate: '2026-10-12', localTime: '10:00', sourceTimeZone: 'America/New_York', dueAt: '2026-10-12T14:00:00Z' },
      }),
    );
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    const result = z
      .object({ result: z.object({ callLogId: z.string().uuid(), callbackId: z.string().uuid() }) })
      .parse(logged.body).result;
    const expected = mode === 'known' ? a : null;
    expect(
      (
        await fixture.db.query('SELECT opportunity_id FROM call_logs WHERE workspace_id=$1 AND id=$2', [
          fixture.alpha.workspaceId,
          result.callLogId,
        ])
      ).rows[0],
    ).toEqual({ opportunity_id: expected });
    expect(
      (
        await fixture.db.query('SELECT opportunity_id FROM callbacks WHERE workspace_id=$1 AND id=$2', [
          fixture.alpha.workspaceId,
          result.callbackId,
        ])
      ).rows[0],
    ).toEqual({ opportunity_id: expected });
  } finally {
    await fixture.stop();
  }
});
