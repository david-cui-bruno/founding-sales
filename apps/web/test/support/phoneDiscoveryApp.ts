import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expect, type Page } from 'playwright/test';
import type { CandidateInput } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { claimJobs } from '@fss/domain/jobs/jobStore.ts';
import type { PageFetchProvider } from '@fss/domain/research/providers.ts';
import { saveCandidate } from '@fss/domain/sourcing/candidates.ts';
import { rememberExpiredManualSources } from '@fss/domain/sourcing/manualProspectSourceLoss.ts';
import { prospectPhoneDiscoveryHandler } from '../../../worker/src/handlers/prospectPhoneDiscovery.ts';
import { runClaimedJob } from '../../../worker/src/runner/jobRunner.ts';
import { QUALIFICATION_PENDING_KEY, qualificationPendingSchema } from '../../src/client/QualificationPending.ts';
import { assertGlassStorage, navigateGlass, requireGlassRuntimeGrant, startGlassWorkspace, type GlassWorkspaceApp } from './glassWorkspaceApp.ts';

export const phoneDiscoveryCase = {
  name: 'FICTIONAL Phone797 ordinary property team',
  website: 'https://phone797.example.test/',
  sourceUrl: 'https://phone797.example.test/about',
  phoneUrl: 'https://phone797.example.test/contact',
  text: 'FICTIONAL Phone797 ordinary property team. Office phone: (214) 555-0123',
  phone: '+12145550123',
} as const;
export const phoneDiscoveryPaths = {
  request: '/sourcing/candidates/phone-discovery/request',
  read: '/sourcing/candidates/phone-discovery/read',
  receipt: '/sourcing/candidates/phone-discovery/receipt',
} as const;

/** New root grant in addition to the existing harness guard. Imports, compilation
 * and linting cannot acquire PG, Chrome, listeners or a resource lease. */
export function requirePhoneDiscoveryRuntimeGrant(): void {
  assert.equal(process.env['FSS_PHONE_DISCOVERY_RUNTIME_GRANT'], '797', 'Separate Fox phone-discovery runtime grant required after Mosquito releases PG');
  requireGlassRuntimeGrant();
}
export async function startPhoneDiscoveryApp() {
  requirePhoneDiscoveryRuntimeGrant();
  return await startGlassWorkspace();
}

const adminContext = (app: GlassWorkspaceApp) => repositoryContext(workspaceScope(app.fixture.alpha.workspaceId, {
  kind: 'user', userId: app.fixture.alpha.admin.userId, role: 'admin',
}), app.fixture.db);

/** Exactly one new ordinary fictional source candidate through its actual owner.
 * The base Glass harness owns its existing inert fixtures. No Glass workflow seed,
 * qualification, discovery promotion, admission or old test is called here. */
export async function seedPhoneDiscoveryCandidate(app: GlassWorkspaceApp) {
  const input: CandidateInput = {
    firmName: phoneDiscoveryCase.name, website: phoneDiscoveryCase.website,
    sourceUrl: phoneDiscoveryCase.sourceUrl, locality: 'Dallas', region: 'TX', signal: 'fit_only',
    evidence: 'FICTIONAL retained ordinary observation. Phone unknown. No contact authority.',
    observedOn: '2026-10-20', preparedBy: 'FICTIONAL Phone797 disposable browser acceptance',
  };
  const saved = await withTransaction(app.fixture.db, () => saveCandidate(adminContext(app), input));
  assert(saved.ok, saved.ok ? '' : saved.reason);
  assert.equal(saved.value.duplicate, false);
  await setPhoneDiscoveryResearch(app, false);
  return { candidateId: saved.value.id, expectedRevision: 1 };
}
export async function setPhoneDiscoveryResearch(app: GlassWorkspaceApp, enabled: boolean): Promise<void> {
  // Disposable fixture configuration only, never an API consent change or a live workspace.
  await app.fixture.db.query(`INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling)
    VALUES($1,$2,1) ON CONFLICT(workspace_id) DO UPDATE SET enabled=$2,daily_firm_ceiling=1`, [app.fixture.alpha.workspaceId, enabled]);
}

const unchangedTables = [
  'sourcing_candidates', 'sourcing_qualification_runs', 'sourcing_admissions', 'firms', 'contacts',
  'phone_routes', 'email_addresses', 'call_logs', 'callbacks', 'today_items', 'sequence_enrollments',
  'step_executions', 'outbound_messages', 'human_reply_send_intents', 'social_posts', 'social_deliveries',
  'provider_reservations', 'suppression_events', 'sourcing_manual_prospect_attempts', 'sourcing_manual_prospect_states',
] as const;
export async function phoneDiscoveryEffectsSnapshot(app: GlassWorkspaceApp): Promise<Record<string, unknown[]>> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of unchangedTables) snapshot[table] = (await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  return snapshot;
}
export async function assertPhoneDiscoveryNoEffects(app: GlassWorkspaceApp, before: Record<string, unknown[]>): Promise<void> {
  expect(await phoneDiscoveryEffectsSnapshot(app)).toEqual(before);
  expect(app.calls()).toBe(0);
  expect(app.runtimeRoleChecks()).toBeGreaterThan(0);
  const jobs = (await app.fixture.db.query<{ kind: string; state: string; max_attempts: number }>('SELECT kind,state,max_attempts FROM jobs')).rows;
  expect(jobs).toEqual([{ kind: 'sourcing.phone_discover', state: 'done', max_attempts: 1 }]);
}

/** Actual claimed API-enqueued job and real worker handler/runner under app_runtime.
 * The only successful-data substitute is the external PageFetchProvider. No DNS,
 * fetch, live HTML, model, route result or domain/projection result is mocked. */
export async function drivePhoneDiscoveryJob(app: GlassWorkspaceApp, runId: string) {
  const runtime = await app.fixture.database.appRuntimeSession();
  expect((await runtime.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role).toBe('app_runtime');
  let fetches = 0;
  const retrievedAt = (await runtime.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
  const body = new TextEncoder().encode(phoneDiscoveryCase.text);
  const contentHash = createHash('sha256').update(body).digest('hex');
  const provider: PageFetchProvider = { providerKey: 'fictional-phone797-no-network', fetchPages: async request => {
    fetches += 1;
    expect(request.firmWebsite).toBe(phoneDiscoveryCase.website);
    expect(request.urls).toEqual([phoneDiscoveryCase.website, phoneDiscoveryCase.sourceUrl]);
    expect(request.prioritizeContactPages).toBe(true);
    expect(request.maxPagesPerFirm).toBeGreaterThan(0);
    expect(request.maxPagesPerFirm).toBeLessThanOrEqual(4);
    expect(request.maxBytes).toBeLessThanOrEqual(1_000_000);
    expect(await request.shouldContinue?.()).toBe(true);
    // The controlled page is still subject to the source owner's exact destination
    // check. A refusal or thrown check must never manufacture a successful page.
    assert(request.mayFetchUrl, 'Phone discovery must bind the exact URL authority guard');
    if (!await request.mayFetchUrl(phoneDiscoveryCase.phoneUrl)) return {
      ok: true, costCents: 0, value: { pages: [], skipped: { source_authority_refused: 1 } },
    };
    return { ok: true, costCents: 0, value: { pages: [{ url: phoneDiscoveryCase.phoneUrl, contentHash,
      retrievedAt, body, contentType: 'text/plain', firstParty: true }], skipped: {} } };
  } };
  const registry = new HandlerRegistry().register(prospectPhoneDiscoveryHandler({ pageFetch: provider }));
  const claims = await claimJobs(runtime, { owner: 'fictional-phone797-browser-acceptance', kinds: registry.kinds(), limit: 1, leaseSeconds: 180 });
  expect(claims).toHaveLength(1);
  const job = claims[0]!;
  expect(job.workspaceId).toBe(app.fixture.alpha.workspaceId);
  expect(job.payload).toEqual({ runId });
  expect(job.maxAttempts).toBe(1);
  expect(await runClaimedJob(runtime, { registry, job })).toBe('completed');
  expect(fetches).toBe(1);
  const stored = (await runtime.query<{ state: string; content: unknown }>('SELECT state,content FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2', [app.fixture.alpha.workspaceId, runId])).rows[0]!;
  expect(stored.state).toBe('complete');
  expect(JSON.stringify(stored.content)).toContain(phoneDiscoveryCase.text);
  expect(JSON.stringify(stored.content)).toContain(contentHash);
  expect(JSON.stringify(stored.content)).toContain(phoneDiscoveryCase.phoneUrl);
  return { retrievedAt, contentHash, fetches: () => fetches };
}

export async function openPhoneDiscoveryCandidate(page: Page, candidateId: string): Promise<void> {
  await navigateGlass(page, 'Prospects');
  await page.getByRole('button', { name: 'Retained review', exact: true }).click();
  await page.locator(`#manual-row-${candidateId}`).click();
  await expect(page.getByRole('article', { name: `Manual prospect ${candidateId}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open calling brief', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Calling', exact: true, level: 1 })).toBeVisible();
  const brief = page.getByRole('region', { name: 'Current calling brief', exact: true });
  await expect(brief).toContainText(phoneDiscoveryCase.name);
  await expect(brief).toContainText('Retained observation · unverified');
  await expect(brief.getByRole('link', { name: 'Open observed website ↗', exact: true })).toHaveAttribute('href', phoneDiscoveryCase.website);
}
export async function assertPhoneDiscoveryStorage(page: Page, candidateId: string, runId?: string): Promise<void> {
  await assertGlassStorage(page, [phoneDiscoveryCase.name, phoneDiscoveryCase.text, phoneDiscoveryCase.phone,
    '(214) 555-0123', phoneDiscoveryCase.website, phoneDiscoveryCase.phoneUrl]);
  const storage = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie }));
  expect(storage).toEqual({ local: [], session: [QUALIFICATION_PENDING_KEY], cookie: '' });
  const raw = await page.evaluate(key => sessionStorage.getItem(key), QUALIFICATION_PENDING_KEY);
  expect(raw).not.toBeNull();
  const held = qualificationPendingSchema.parse(JSON.parse(raw!));
  expect(held.command.kind).toBe('phone_discovery');
  expect(held.command.payload).toEqual({ commandId: held.command.payload.commandId, candidateId, expectedRevision: 1 });
  if (runId) expect(held.receipt).toEqual({ kind: 'phone_discovery', result: { runId } });
  else expect(held.receipt).toBeUndefined();
}
export async function withdrawPhoneDiscoverySource(app: GlassWorkspaceApp): Promise<void> {
  await withTransaction(app.fixture.db, () => rememberExpiredManualSources(adminContext(app), [phoneDiscoveryCase.sourceUrl]));
}
