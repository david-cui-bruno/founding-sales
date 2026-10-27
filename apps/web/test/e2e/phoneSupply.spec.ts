import { createHash } from 'node:crypto';
import { expect, test as base } from 'playwright/test';
import { manualProspectListSchema, prospectPhoneDiscoveryQueuedSchema, prospectPhoneDiscoveryViewSchema } from '@fss/contracts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { claimJobs } from '@fss/domain/jobs/jobStore.ts';
import type { PageFetchProvider } from '@fss/domain/research/providers.ts';
import { prospectPhoneDiscoveryHandler } from '../../../worker/src/handlers/prospectPhoneDiscovery.ts';
import { runClaimedJob } from '../../../worker/src/runner/jobRunner.ts';
import { browserRequest } from '../support/browser.ts';
import { assertGlassNoExternalActions, containGlass, signInGlass } from '../support/glassWorkspaceApp.ts';
import { launchGlassContext } from '../support/glassWorkspaceBrowser.ts';
import { assertPhoneDiscoveryNoEffects, openPhoneDiscoveryCandidate, phoneDiscoveryCase, phoneDiscoveryEffectsSnapshot, phoneDiscoveryPaths, requirePhoneDiscoveryRuntimeGrant, seedPhoneDiscoveryCandidate, setPhoneDiscoveryResearch, startPhoneDiscoveryApp } from '../support/phoneDiscoveryApp.ts';

let owned: Awaited<ReturnType<typeof startPhoneDiscoveryApp>> | undefined;
let candidate: Awaited<ReturnType<typeof seedPhoneDiscoveryCandidate>>;
const app = () => { if (!owned) throw Error('Separate phone supply runtime grant required'); return owned.app; };
const test = base.extend({ context: async ({ browserName }, use) => {
  expect(process.env['FSS_PHONE_SUPPLY_BROWSER_GRANT']).toBe('whole-original-142');
  expect(owned).toBeDefined();
  expect(browserName).toBe('chromium');
  const browser = await launchGlassContext();
  try { await use(browser.context); } finally { await browser.stop(); }
} });
test.use({ ignoreHTTPSErrors: true, actionTimeout: 15_000, screenshot: 'off', trace: 'off', video: 'off' });
test.describe.configure({ timeout: 180_000 });
test.beforeAll(async () => {
  expect(process.env['FSS_PHONE_SUPPLY_BROWSER_GRANT']).toBe('whole-original-142');
  requirePhoneDiscoveryRuntimeGrant();
  owned = await startPhoneDiscoveryApp();
  candidate = await seedPhoneDiscoveryCandidate(owned.app);
});
test.afterAll(async () => {
  if (!owned) return;
  try { await assertGlassNoExternalActions(owned.app); } finally { await owned.stop(); owned = undefined; }
});

// Authoring is not runtime permission. One fictional changed path exercises all
// three former capacity failures without changing block boundaries or selection.
test('whole larger capture persists through signed read/list as manual alternatives, never a selected phone', async ({ context, page }) => {
  await containGlass(context, app());
  await signInGlass(page, app());
  const baseline = await phoneDiscoveryEffectsSnapshot(app());
  await setPhoneDiscoveryResearch(app(), true);
  await openPhoneDiscoveryCandidate(page, candidate.candidateId);
  const discovery = page.getByRole('region', { name: 'Business phone discovery', exact: true });
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === `/browser/api${phoneDiscoveryPaths.request}`);
  await discovery.getByRole('button', { name: 'Find business phone', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(200);
  const envelope = await response.json() as { status: string; result: unknown };
  expect(envelope.status).toBe('accepted');
  const { runId } = prospectPhoneDiscoveryQueuedSchema.parse(envelope.result);
  const runtime = await app().fixture.database.appRuntimeSession();
  const retrievedAt = (await runtime.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
  const blocks = ['FICTIONAL '.repeat(1450) + 'Office phone: (214) 555-0123', 'Office phone: (214) 555-0456', ...Array.from({ length: 99 }, (_, i) => `FICTIONAL unchanged context ${i}`)];
  expect(blocks).toHaveLength(101);
  expect(blocks[0]!.length).toBeGreaterThan(12_000);
  const body = new TextEncoder().encode(blocks.map(text => `<p>${text}</p>`).join(''));
  const contentHash = createHash('sha256').update(body).digest('hex');
  let fetches = 0;
  const provider: PageFetchProvider = { providerKey: 'fictional-phone-supply-no-network', fetchPages: async request => {
    fetches += 1;
    expect(await request.shouldContinue?.()).toBe(true);
    expect(request.mayFetchUrl).toBeDefined();
    expect(await request.mayFetchUrl!(phoneDiscoveryCase.phoneUrl)).toBe(true);
    return { ok: true, costCents: 0, value: { pages: [{ url: phoneDiscoveryCase.phoneUrl, retrievedAt, body, contentHash, contentType: 'text/html', firstParty: true }], skipped: {} } };
  } };
  const registry = new HandlerRegistry().register(prospectPhoneDiscoveryHandler({ pageFetch: provider }));
  const claims = await claimJobs(runtime, { owner: 'fictional-phone-supply-browser', kinds: registry.kinds(), limit: 1, leaseSeconds: 180 });
  expect(claims).toHaveLength(1);
  expect(claims[0]!.payload).toEqual({ runId });
  expect(await runClaimedJob(runtime, { registry, job: claims[0]! })).toBe('completed');
  const stored = (await runtime.query<{ content: { observations: { contentHash: string; blocks: { text: string }[] }[] } }>('SELECT content FROM sourcing_prospect_phone_discoveries WHERE id=$1', [runId])).rows[0]!.content.observations[0]!;
  expect(stored.contentHash).toBe(contentHash);
  expect(stored.blocks.map(block => block.text)).toEqual(blocks);
  const ready = page.waitForResponse(result => new URL(result.url()).pathname === `/browser/api${phoneDiscoveryPaths.read}`);
  await discovery.getByRole('button', { name: 'Read phone result', exact: true }).click();
  const read = await ready;
  expect(read.status()).toBe(200);
  expect(prospectPhoneDiscoveryViewSchema.parse(await read.json())).toMatchObject({ state: 'complete', channelAuthority: 'not_granted', phoneEvidence: { state: 'conflicting' } });
  const panel = discovery.getByLabel('Current phone discovery result', { exact: true });
  await panel.getByText('Phone-specific sources and coverage', { exact: true }).click();
  for (const literal of ['(214) 555-0123', '(214) 555-0456']) await expect(panel).toContainText(`Retained literal: ${literal}`);
  for (const value of ['+12145550123', '+12145550456']) await expect(panel).toContainText(`Supported normalized alternative: ${value}`);
  await expect(panel).toContainText('Not selected or verified.');
  await expect(panel).toContainText('Source label: Office phone');
  await expect(panel).toContainText(retrievedAt);
  await expect(panel.getByRole('link', { name: phoneDiscoveryCase.phoneUrl, exact: true }).first()).toHaveAttribute('href', phoneDiscoveryCase.phoneUrl);
  await expect(panel).not.toContainText('observed, not call-ready');
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  const listed = await browserRequest(page, '/sourcing/candidates/prospects/list', { body: { state: 'all', offset: 0 } });
  expect(listed.status).toBe(200);
  expect(manualProspectListSchema.parse(listed.body).prospects.find(row => row.candidateId === candidate.candidateId)).toMatchObject({ observedPhone: null, qualification: 'unverified', contactAuthority: 'not_granted', phoneEvidence: { state: 'conflicting' } });
  expect(fetches).toBe(1);
  await assertPhoneDiscoveryNoEffects(app(), baseline);
});
