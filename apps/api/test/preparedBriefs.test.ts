import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firmPageResponseSchema, preparedBriefMatchResponseSchema, todayFirmResponseSchema } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { buildTodaySnapshot } from '@fss/domain/today/build.ts';
import { businessDateOf } from '@fss/domain/today/snapshots.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
import { todayFirmResponseSchema as legacyTodayFirmResponseSchema } from './support/today134dc811.ts';

/**
 * Lane PB: a firm's prepared brief over the wire (migration 0038).
 *
 *   * `POST /firms/brief/set` and `/firms/brief/clear`: the assignee or an admin; bounds are a
 *     malformed body; a replay of one command id answers the same and writes once; neither the
 *     receipt nor the audit row holds the text.
 *   * `include: ['preparedBrief']` on `POST /crm/firm-page` and `POST /today/firm`: without it
 *     the answer is the shape an installed desktop parses strictly; with it, the brief or null.
 *   * `POST /firms/brief/match`: an administrator's read, by the importer's matcher.
 */
describe('prepared briefs over the wire', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salesToken: string;
  let ownFirm: string;
  let colleagueFirm: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
  });

  const call = async (token: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };
  const envelope = () => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION });

  const TEXT = 'Who to ask for: Robin Placeholder, Broker (likely)\nBrief: owners in Plano.';
  const full = (firmId: string) => ({
    ...envelope(),
    firmId,
    brief: TEXT,
    sources: [
      { url: 'https://firm.example.test/contact', label: 'Phone source' },
      { url: 'https://firm.example.test/team', label: 'Decision-maker' },
    ],
    observedOn: '2026-10-02',
    preparedBy: 'Callie research agent (web), verified phones',
  });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salesToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    ownFirm = await seedFirm(fixture, {
      name: 'Prepared Wire Own Test Co',
      website: 'https://own.example.test',
      regionCode: 'TX',
      externalId: 'dfw-20261002-e01',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    colleagueFirm = await seedFirm(fixture, {
      name: 'Prepared Wire Colleague Test Co',
      regionCode: 'TX',
      assignedUserId: fixture.alpha.admin.userId,
    });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('lets the assignee set a brief and replays the same answer for the same command id, writing once', async () => {
    const body = full(ownFirm);
    const first = await call(salesToken, '/firms/brief/set', body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['result']).toMatchObject({ firmId: ownFirm, created: true, briefLength: TEXT.length, sourceCount: 2 });
    const replay = await call(salesToken, '/firms/brief/set', body);
    expect(replay.status).toBe(200);
    expect(replay.body['replayed']).toBe(true);
    expect(replay.body['result']).toEqual(first.body['result']);
    // The same id with another payload is refused, not applied.
    const mismatch = await call(salesToken, '/firms/brief/set', { ...body, brief: 'Something else' });
    expect(mismatch.body['reason']).toBe('command_payload_mismatch');

    const audits = await fixture.db.query<{ detail: unknown }>(
      `SELECT detail FROM audit_events WHERE workspace_id = $1 AND subject_id = $2 AND action = 'firm.prepared_brief_set'`,
      [fixture.alpha.workspaceId, ownFirm],
    );
    expect(audits.rows).toHaveLength(1);
    const receipts = await fixture.db.query<{ result: unknown }>(
      `SELECT result FROM command_receipts WHERE workspace_id = $1 AND command_id = $2`,
      [fixture.alpha.workspaceId, body.commandId],
    );
    expect(receipts.rows).toHaveLength(1);
    for (const stored of [audits.rows, receipts.rows]) {
      expect(JSON.stringify(stored)).not.toContain('Robin Placeholder');
      expect(JSON.stringify(stored)).not.toContain('firm.example.test');
    }
  });

  it('refuses a salesperson on a colleague’s firm, and lets an admin', async () => {
    const refused = await call(salesToken, '/firms/brief/set', full(colleagueFirm));
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('not_assigned');
    const clear = await call(salesToken, '/firms/brief/clear', { ...envelope(), firmId: colleagueFirm });
    expect(clear.body['reason']).toBe('not_assigned');
    expect((await call(adminToken, '/firms/brief/set', full(colleagueFirm))).status).toBe(200);
  });

  it('answers out-of-bounds input as a malformed body', async () => {
    const bad = [
      { ...full(ownFirm), brief: 'x'.repeat(4001) },
      { ...full(ownFirm), sources: [{ url: 'http://firm.example.test/', label: 'Source' }] },
      { ...full(ownFirm), sources: [{ url: 'https://firm.example.test/', label: 'x'.repeat(201) }] },
      { ...full(ownFirm), sources: Array.from({ length: 31 }, () => ({ url: 'https://firm.example.test/', label: 'S' })) },
      { ...full(ownFirm), sources: [{ url: 'https://firm.example.test/', label: 'S', extra: 1 }] },
      { ...full(ownFirm), observedOn: 'yesterday' },
      { ...full(ownFirm), unknown: true },
    ];
    for (const body of bad) expect((await call(adminToken, '/firms/brief/set', body)).status).toBe(400);
  });

  it('adds the brief to the firm page only when negotiated, so an installed desktop’s strict parse never meets it', async () => {
    const detail = firmPageResponseSchema.options[1];
    const legacyPage = detail.omit({ preparedBrief: true });

    const without = await call(salesToken, '/crm/firm-page', { firmId: ownFirm, pageVersion: 2 });
    expect(without.status).toBe(200);
    expect('preparedBrief' in without.body).toBe(false);
    expect(legacyPage.safeParse(without.body).success).toBe(true);

    const withBrief = await call(salesToken, '/crm/firm-page', { firmId: ownFirm, pageVersion: 2, include: ['stops', 'preparedBrief'] });
    expect(withBrief.status).toBe(200);
    const parsed = detail.parse(withBrief.body);
    expect(parsed.preparedBrief).toMatchObject({ brief: TEXT, observedOn: '2026-10-02', sources: [{ label: 'Phone source' }, { label: 'Decision-maker' }] });
    expect(parsed.stops).toBeDefined();
    expect(legacyPage.safeParse(withBrief.body).success).toBe(false);
    // The vocabulary is closed.
    expect((await call(salesToken, '/crm/firm-page', { firmId: ownFirm, include: ['everything'] })).status).toBe(400);
  });

  it('adds the brief to the Today card only when negotiated, and null for a firm with none', async () => {
    const worker = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);
    const { rows } = await fixture.db.query<{ now: Date }>('SELECT now() AS now');
    const now = (rows[0]?.now ?? new Date()).toISOString();
    await buildTodaySnapshot(worker, { businessDate: await businessDateOf(worker, now), now });

    const plain = await call(salesToken, '/today/firm', { firmId: ownFirm, cardVersion: 2 });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect('preparedBrief' in plain.body).toBe(false);
    const legacy = await call(salesToken, '/today/firm', { firmId: ownFirm });
    expect(legacyTodayFirmResponseSchema.safeParse(legacy.body).success).toBe(true);

    const negotiated = await call(salesToken, '/today/firm', { firmId: ownFirm, cardVersion: 2, include: ['tasks', 'preparedBrief'] });
    expect(negotiated.status).toBe(200);
    expect(todayFirmResponseSchema.parse(negotiated.body).preparedBrief?.brief).toBe(TEXT);

    // Version 1 never carries it, even when asked.
    const version1 = await call(salesToken, '/today/firm', { firmId: ownFirm, include: ['preparedBrief'] });
    expect('preparedBrief' in version1.body).toBe(false);

    await call(salesToken, '/firms/brief/clear', { ...envelope(), firmId: ownFirm });
    const cleared = await call(salesToken, '/today/firm', { firmId: ownFirm, cardVersion: 2, include: ['preparedBrief'] });
    expect(cleared.body['preparedBrief']).toBeNull();
  });

  it('matches rows by external id for an admin, and refuses a salesperson', async () => {
    const rows = [{ externalId: 'dfw-20261002-e01' }, { externalId: 'dfw-20261002-x99' }, { website: 'https://www.own.example.test/about' }];
    const matched = await call(adminToken, '/firms/brief/match', { rows });
    expect(matched.status).toBe(200);
    expect(preparedBriefMatchResponseSchema.parse(matched.body).rows).toEqual([
      { status: 'matched', firmId: ownFirm, firmName: 'Prepared Wire Own Test Co', matchedOn: 'external_id' },
      { status: 'unmatched' },
      { status: 'matched', firmId: ownFirm, firmName: 'Prepared Wire Own Test Co', matchedOn: 'domain' },
    ]);
    const refused = await call(salesToken, '/firms/brief/match', { rows });
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('admin_only');
  });
});
