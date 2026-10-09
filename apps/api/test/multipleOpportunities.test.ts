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
