import { randomUUID, createHash } from 'node:crypto';
import { expect, type BrowserContext, type Page } from 'playwright/test';
import { callingFollowUpSaveInputSchema } from '@fss/contracts';
import { browserRequest, browserSession } from './browser.ts';
import { assertGlassStorage, navigateGlass, type GlassWorkspaceApp } from './glassWorkspaceApp.ts';
import { glassSaveAcceptance, glassWrapAcceptance } from './glassWorkspaceContracts.ts';
import { privateDraftCanonicalJson } from '../../src/client/PrivateDraftCustody.ts';
import type { GlassWorkspaceSeed } from './glassWorkspaceSeed.ts';

const custodyKey = 'callie.browser.pending-calling-follow-up.v1';
type Held = { commandId: string; draftId: string; payloadSHA256: string; expectedRevision: number };
const records = async (page: Page): Promise<Held[]> => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '[]') as Held[], custodyKey);
async function openFollowUp(page: Page, draftId: string): Promise<void> {
  await navigateGlass(page, 'Email');
  await page.getByRole('navigation', { name: 'Email views' }).getByRole('button', { name: 'Follow-ups', exact: true }).click();
  await page.locator('[aria-label="Follow-up metadata"]').getByRole('button', { name: new RegExp(`^Draft ${draftId}\\b`, 'u') }).click();
  await expect(page.getByRole('textbox', { name: 'Follow-up body', exact: true })).toBeVisible();
}

/** Actual HTTP commits with deliberately lost transport responses, never invented success.
 * Two same-identity tabs exercise the shared bounded registry and offscreen auth observer. */
export async function acceptGlassTwoTabUnknown(page: Page, context: BrowserContext, app: GlassWorkspaceApp, seed: GlassWorkspaceSeed): Promise<void> {
  const first = { draftId: randomUUID() }, secondId = randomUUID();
  // Independent fictional observations through the actual signed API/domain.
  // No earlier accepted UI path needs replaying to run this outcome by itself.
  for (const [candidateId, draftId] of [[seed.candidateId, first.draftId], [seed.otherCandidateId, secondId]]) {
    const created = await browserRequest(page, '/calling/wrap', { body: {
      kind: 'candidate', candidateId, expectedCandidateRevision: 1, attemptId: randomUUID(), commandId: randomUUID(),
      report: { performedByUser: true, channel: 'manual_phone', occurrence: { kind: 'unknown' }, result: 'conversation', note: 'FICTIONAL two-tab fixture, no real phone action.', callback: null },
      promisedEmail: { draftId, nextAction: 'promised_email', subject: 'FICTIONAL two-tab independent promise', body: 'FICTIONAL independent private promise. No sending.' },
    } });
    expect(created.status).toBe(200);
    expect(glassWrapAcceptance.parse(created.body).result.followUp).toMatchObject({ state: 'queued_for_review', draftId, revision: 1 });
  }
  const other = await context.newPage();
  const saved = new Map<string, { commandId: string; payloadSHA256: string }>();
  let dispatches = 0;
  const pattern = '**/browser/api/calling/follow-ups/save';
  try {
    await other.goto(app.origin);
    await expect(other.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await openFollowUp(page, first.draftId);
    await openFollowUp(other, secondId);
    for (const target of [page, other]) await target.route(pattern, async route => {
      dispatches += 1;
      const { commandId, clientVersion, ...raw } = route.request().postDataJSON() as Record<string, unknown>;
      expect(clientVersion).toBeUndefined();
      const payload = callingFollowUpSaveInputSchema.parse(raw);
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect(glassSaveAcceptance.parse(await response.json()).result).toEqual({ draftId: payload.draftId, revision: payload.expectedRevision + 1 });
      saved.set(payload.draftId, { commandId: String(commandId), payloadSHA256: createHash('sha256').update(privateDraftCanonicalJson(payload)).digest('hex') });
      console.log('GLASS783_UNKNOWN_REAL_COMMIT', JSON.stringify({ draftId: payload.draftId, ...saved.get(payload.draftId), registry: await records(target) }));
      await route.abort('failed'); // Server committed, but browser has no acceptance evidence.
    });
    const privateA = 'FICTIONAL lost response A. Never store this private body in custody.';
    const privateB = 'FICTIONAL lost response B. Never store this private body in custody.';
    await page.getByRole('textbox', { name: 'Follow-up body', exact: true }).fill(privateA);
    await other.getByRole('textbox', { name: 'Follow-up body', exact: true }).fill(privateB);
    await Promise.all([page, other].map(target => target.getByRole('button', { name: 'Save private follow-up', exact: true }).click()));
    for (const target of [page, other]) await expect(target.getByText('Save outcome UNKNOWN.', { exact: false })).toBeVisible();
    const both = await records(page);
    console.log('GLASS783_UNKNOWN_CONSERVATION', JSON.stringify({ dispatches, committed: [...saved], registry: both, otherRegistry: await records(other) }));
    expect(saved.size, 'Both distinct saves must have actual backend acceptance before transport loss').toBe(2);
    expect(both).toHaveLength(2);
    for (const held of both) expect(held).toMatchObject(saved.get(held.draftId)!);
    expect(both.map(value => value.draftId).sort()).toEqual([first.draftId, secondId].sort());
    expect(await records(other)).toEqual(both);
    await assertGlassStorage(page, [privateA, privateB]);
    // A refresh/new same-identity session lease cannot discard the other tab's UNKNOWN.
    await page.reload();
    await openFollowUp(page, first.draftId);
    expect(await records(page)).toEqual(both);
    await expect(page.getByRole('button', { name: 'Save private follow-up', exact: true })).toBeDisabled();
    const receiptReady = page.waitForResponse(response => new URL(response.url()).pathname === '/browser/api/calling/follow-ups/receipt');
    await page.getByRole('button', { name: 'Check same follow-up receipt', exact: true }).click();
    const receipt = await receiptReady;
    expect(receipt.status()).toBe(200);
    expect(receipt.request().postDataJSON()).toEqual({ operation: 'save', ...saved.get(first.draftId) });
    await expect(page.getByRole('textbox', { name: 'Follow-up body', exact: true })).toHaveValue(privateA);
    const remaining = both.filter(value => value.draftId === secondId);
    await expect.poll(() => records(page)).toEqual(remaining);
    expect(await records(other)).toEqual(remaining);
    expect(dispatches).toBe(2);
    // Reopen B in the other tab: only exact receipt recovery is allowed, never replacement Save.
    await navigateGlass(page, 'Social');
    await openFollowUp(page, secondId);
    await expect(page.getByRole('button', { name: 'Save private follow-up', exact: true })).toBeDisabled();
    expect(await records(page)).toEqual(remaining);
    await navigateGlass(page, 'Social');
    await navigateGlass(other, 'Social');
    const session = await browserSession(page);
    if (session.status !== 'signed_in') throw Error('Real signed identity required');
    await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1", [session.deviceId]);
    // Actual mounted product request causes 401 and app-lifetime invalidation while Email is absent.
    await page.getByRole('button', { name: 'List saved private drafts', exact: true }).click();
    for (const target of [page, other]) {
      await expect(target.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
      await expect.poll(() => records(target)).toEqual([]);
      await expect(target.getByRole('textbox', { name: 'Follow-up body', exact: true })).toHaveCount(0);
      await assertGlassStorage(target, [privateA, privateB]);
    }
    expect(dispatches).toBe(2);
    expect((await browserRequest(page, '/calling/follow-ups/list', { body: {} })).status).toBe(401);
  } finally {
    await page.unroute(pattern);
    await other.unroute(pattern);
    await other.close();
  }
}
