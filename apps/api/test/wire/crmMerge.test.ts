import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mayMutate, mergeRefusalSchema, wireDrift } from '@fss/contracts';
import { CONTAINER_CLIENT_VERSIONS } from '../../src/bootstrap/main.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from '../support/authFixture.ts';
import { issueSessionFor } from '../support/sessionFixture.ts';
import { seedFirm } from '../support/crmSeed.ts';
import { conflictsOf, createCrmBridge } from '../../../desktop/src/main/crmBridge.ts';
import { MERGE_HEADING, buildFirmWorkspaceView, mergeSubmittable } from '../../../desktop/src/renderer/firmWorkspaceView.ts';
import { DESKTOP_VERSION_UNDER_TEST, desktopClient } from '../support/wireThrough.ts';

/**
 * A refused merge reaches the conflict screen (release.md 8.0aj; lane g78, audit item
 * D05).
 *
 * `POST /merges/firms` refuses a merge whose records disagree with `merge_conflicts`
 * and the fields in question (`apps/api/src/routes/merges.ts`), and G3b built the
 * screen that resolves them (`firmMerge.ts`). The two never met. The desktop transport
 * reduced every refusal to its reason, so the conflicts were dropped in
 * `authedClient.ts`; the CRM bridge never set `merge`, so the screen could not open;
 * and a replay of the same command id answered from a receipt that kept the reason and
 * not the conflicts, so even a transport that kept the body would have had nothing to
 * draw on a retry.
 *
 * ## The vacuous-pass traps, named
 *
 * **Two records that agree.** A merge with nothing to resolve never refuses, and the
 * screen is never needed. The two firms here disagree on their website and locality.
 *
 * **A fresh refusal only.** The route always attached conflicts to a first refusal; the
 * receipt was the gap. The same command id is sent twice here, and the replay must
 * carry the same list.
 */

describe('8.0aj: a refused merge opens the conflict screen (lane g78)', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let targetId = '';
  let sourceId = '';

  const created = async (fields: { name: string; website: string; locality?: string }): Promise<string> =>
    await seedFirm(fixture, fields);

  const bridge = () =>
    createCrmBridge({
      api: desktopClient(fixture, adminToken),
      clientVersion: CURRENT_CLIENT_VERSION,
      session: { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) },
    });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    targetId = await created({ name: 'Northwind Test Holdings', website: 'https://northwind.example.test', locality: 'Providence' });
    sourceId = await created({ name: 'Northwind Test Holdings (dup)', website: 'https://dup.example.test', locality: 'Pawtucket' });
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('opens the conflict screen from the real refusal, with both records named', async () => {
    const crm = bridge();
    const state = await crm.resolveMerge({ sourceFirmId: sourceId, targetFirmId: targetId, resolutions: {} });

    expect(state.notice).toBe('merge_conflicts');
    expect(state.screen).toBe('merge');
    expect(state.merge).toMatchObject({
      sourceFirmId: sourceId,
      sourceName: 'Northwind Test Holdings (dup)',
      targetFirmId: targetId,
      targetName: 'Northwind Test Holdings',
    });
    expect(state.merge?.conflicts.map(conflict => [conflict.field, conflict.source, conflict.target])).toEqual([
      ['website', 'https://dup.example.test', 'https://northwind.example.test'],
      ['locality', 'Pawtucket', 'Providence'],
    ]);

    const view = buildFirmWorkspaceView(state);
    expect(view.heading).toBe(MERGE_HEADING);
    expect(view.banners.map(banner => banner.text)).toContain('These two records disagree. Choose which value to keep for each.');
    const merge = state.merge;
    if (merge === null) throw new Error('no merge view');
    expect(mergeSubmittable(merge, {}, view.actionsEnabled)).toBe(false);
    expect(mergeSubmittable(merge, { website: 'https://northwind.example.test', locality: 'Providence' }, view.actionsEnabled)).toBe(true);

    // Resolved, the same command succeeds and the window moves to the surviving firm.
    const merged = await crm.resolveMerge({
      sourceFirmId: sourceId,
      targetFirmId: targetId,
      resolutions: { website: 'https://northwind.example.test', locality: 'Providence' },
    });
    expect(merged.notice).toBe('merged');
    expect(merged.merge).toBeNull();
    expect(merged.screen).toBe('firm');
  });

  it('carries the conflicts through the transport on a replay of the same command id', async () => {
    const first = await created({ name: 'Harbor Test Partners', website: 'https://harbor.example.test' });
    const second = await created({ name: 'Harbor Test Partners (dup)', website: 'https://harbor-dup.example.test' });
    const api = desktopClient(fixture, adminToken);
    const commandId = randomUUID();
    const payload = { sourceFirmId: second, targetFirmId: first };

    const fresh = await api.command('/merges/firms', payload, () => null, { commandId });
    const replay = await api.command('/merges/firms', payload, () => null, { commandId });
    for (const [label, answer] of [['fresh', fresh], ['replay', replay]] as const) {
      expect(answer.ok, label).toBe(false);
      if (answer.ok || answer.offline) throw new Error(`${label}: not a refusal`);
      expect(answer.reason, label).toBe('merge_conflicts');
      expect(wireDrift(mergeRefusalSchema, answer.refusal), label).toEqual([]);
      expect(conflictsOf(answer.refusal).map(conflict => conflict.field), label).toEqual(['website']);
    }
    // The second answer came from the receipt, and still carried the list.
    if (replay.ok || replay.offline) throw new Error('replay: not a refusal');
    expect((replay.refusal as { replayed?: unknown }).replayed).toBe(true);
  });

  it('is a build the deployed API accepts', () => {
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, DESKTOP_VERSION_UNDER_TEST)).toBe(true);
  });
});
