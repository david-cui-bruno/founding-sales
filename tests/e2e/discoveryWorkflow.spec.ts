import { createHash } from 'node:crypto';
import { AxeBuilder } from '@axe-core/playwright';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'playwright/test';
import { launchFounderWorkspace, navigateFounderRoute, type FounderWorkspace } from '../support/founderWorkspace';
import { allocatePackagedFixtureDatabase } from '../support/packagedFixtureDatabase';
import { validParcelEvent, validEnrichmentEvent } from '../fixtures/cloudSourceEvents';
import type { LeadsListRequest } from '../../src/shared/contracts/leadsContract';
import { cloudSourceEventSchema } from '../../src/shared/contracts/cloudSourceEventContract';

// SOURCE PREPARATION ONLY until root authorizes the one-artifact packaged slot.
// stop/close are bounded termination, NOT native normal Quit or descendant proof.
// Root's separate native observation owns those facts and wordmark/drag/navigation.
test.describe.configure({ mode: 'serial' });
const listRequest: LeadsListRequest = { query: '', stages: [], priorities: [], sort: 'priority' as const, cursor: null, limit: 200 };
const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
function event(index: number) {
  const value = validParcelEvent(); const hash = createHash('sha256').update(`packaged-discovery-${index}`).digest('hex');
  value.id = `se_0${hash.slice(0, 25).toUpperCase()}`; value.idempotency_key = hash;
  value.entity.cloud_entity_id = `ce_0${hash.slice(0, 25).toUpperCase()}`;
  value.entity.person!.full_name = index % 3 === 0 ? `Synthetic ${index} Holdings LLC` : `Synthetic Owner ${index}`;
  value.entity.person!.org_names = []; value.entity.person!.phones = [];
  value.entity.person!.emails = [];
  value.entity.property!.situs_address.line1 = `${100 + index} Synthetic St`;
  value.entity.property!.parcel_id = `PACKAGED-SYNTHETIC-${index}`;
  value.entity.property!.unit_count = index % 10 === 9 ? null : index % 2 === 0 ? 10 : 6;
  value.entity.property!.year_built = index % 10 === 9 ? null : index % 2 === 0 ? 1918 : 1970;
  value.source_uri = `fixture:discovery:${index}`;
  return cloudSourceEventSchema.parse(value);
}

test('P1 automatic source evidence, unfinished-work restart, contact-first workspace and persistent unsent draft', async () => {
  const info = test.info();
  test.setTimeout(240_000); // Real worker's bounded minute scan, never a test repair API.
  const directory = await mkdtemp(join(tmpdir(), 'callie-sourcing-fixture-'));
  let workspace: FounderWorkspace | undefined; let first: FounderWorkspace | undefined;
  try {
    await mkdir(join(directory, 'events', '2026-09-06'), { recursive: true });
    // A bounded125-owner intake provides a real unfinished-work checkpoint beyond25.
    await writeFile(join(directory, 'events', '2026-09-06', 'aaa-discovery.ndjson'),
      Array.from({ length: 125 }, (_, i) => JSON.stringify(event(i))).join('\n') + '\n');
    first = await launchFounderWorkspace({ env: { CALLIE_SOURCING_FIXTURE_DIR: directory } }); workspace = first;
    const status = await workspace.page.evaluate(() => window.callie.sourcing.pollNow());
    expect(status.counters.imported).toBe(125);
    const unfinished = await workspace.page.evaluate(async request => {
      const people = (await window.callie.leads.list(request)).rows;
      return Promise.all(people.map(row => window.callie.discovery.getBrief({ personId: row.personId })));
    }, listRequest);
    expect(unfinished.filter(b => b.assessment === null || b.stale).length,
      'Must observe unfinished per-owner work, not a bounded aggregate count or a finished shortlist').toBeGreaterThan(0);
    await workspace.stop();
    workspace = await launchFounderWorkspace({ userDataPath: first.userDataPath, env: { CALLIE_SOURCING_FIXTURE_DIR: directory } });
    const { page } = workspace;
    // Snapshot counts are a bounded read (50 checked owners), not a completion oracle for125.
    const allOwners = (await page.evaluate(request => window.callie.leads.list(request), listRequest)).rows;
    expect(allOwners).toHaveLength(125);
    const briefs = () => page.evaluate(async people => Promise.all(people.map(personId => window.callie.discovery.getBrief({ personId }))), allOwners.map(row => row.personId));
    await expect.poll(async () => (await briefs()).filter(b => b.assessment !== null && !b.stale).length, { timeout: 90_000 }).toBe(125);
    expect(new Set((await briefs()).map(b => b.assessment!.id)).size).toBe(125);
    await expect.poll(() => page.evaluate(async () => (await window.callie.discovery.get()).processing)).toBe('idle');
    const snapshot = await page.evaluate(() => window.callie.discovery.get());
    expect(snapshot.prepared).toHaveLength(10);
    await expect(page.getByText('Prepared conversations', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Refresh shortlist', exact: true })).toHaveCount(0);
    const suggestions = page.getByRole('region', { name: 'Suggested contacts' });
    await expect(suggestions).toBeVisible();
    await expect(suggestions.getByRole('button')).toHaveCount(3);
    for (const theme of ['dark', 'light'] as const) {
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      await page.getByRole('region', { name: 'Appearance', exact: true })
        .getByRole('button', { name: theme === 'light' ? 'Light appearance' : 'Dark appearance', exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('link', { name: 'Today', exact: true }).click();
      await expect(suggestions.getByRole('button')).toHaveCount(3);
      for (const width of [1050, 1440]) {
        await page.setViewportSize({ width, height: width === 1050 ? 700 : 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        const accessibility = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
        expect(accessibility.violations.filter(v => ['serious', 'critical'].includes(v.impact ?? ''))
          .map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), `${theme} suggestions ${width}`).toEqual([]);
        await page.screenshot({ path: info.outputPath(`${theme}-suggested-contacts-${width}.png`), animations: 'disabled' });
      }
    }
    const selected = snapshot.prepared[0];
    expect(selected).toBeDefined();
    const selectedIndex = Number(selected.personName.match(/\d+/)![0]);
    const id = selected!.personId;
    const before = await page.evaluate(request => window.callie.leads.list(request), listRequest);
    expect(before.rows).toHaveLength(125); expect(before.rows.every(row => row.stage === 'unreviewed' && row.lastActivityAt === null)).toBe(true);
    await suggestions.getByRole('button', { name: selected.personName, exact: true }).click();
    const inspector = page.getByRole('complementary', { name: `${selected!.personName} details` });
    await expect(inspector.getByRole('region', { name: 'Known portfolio', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('source-backed-portfolio-overview.png'), animations: 'disabled' });
    await inspector.getByText('Details', { exact: true }).click();
    const ref = selected!.assessment!.claims.flatMap(c => c.refs).find(ref => ref.kind === 'source')!;
    if (ref.kind !== 'source') throw new Error('Expected retained source citation');
    await expect(inspector.getByText(`Source ${ref.sourceEventId}, ${ref.field}, ${ref.observedAt}`, { exact: true }).first()).toBeVisible();
    expect((await page.evaluate(personId => window.callie.leadDetail.get({ personId }), id)).stage).toBe('unreviewed');
    expect((await page.evaluate(personId => window.callie.leadDetail.get({ personId }), id)).emails).toEqual([]);
    await inspector.getByText('Details', { exact: true }).click();
    // Actual user action, real preparation and real writer. The package fixture
    // substitutes only the external storage boundary, not admission or success.
    await inspector.getByRole('button', { name: 'Find contact info', exact: true }).click();
    const requestDirectory = join(directory, 'upstream', 'enrichment-requests');
    await expect.poll(async () => {
      try { return (await readdir(requestDirectory)).filter(name => name.endsWith('.ndjson')).length; }
      catch { return 0; }
    }).toBe(1);
    const requestFile = (await readdir(requestDirectory))[0];
    const request = JSON.parse(await readFile(join(requestDirectory, requestFile), 'utf8'));
    expect(request).toMatchObject({ cloud_entity_id: event(selectedIndex).entity.cloud_entity_id,
      owner_full_name: selected.personName,
      situs_address: { line1: `${100 + selectedIndex} synthetic st`, locality: 'providence', region: 'ri', postal_code: '02906' } });
    await expect.poll(() => page.evaluate(personId => window.callie.leadDetail.get({ personId }), id)).toMatchObject({ stage: 'ready' });
    const ready = await page.evaluate(personId => window.callie.leadDetail.get({ personId }), id);
    expect(ready.activities).toEqual([]); expect(ready.nextAction).not.toBeNull();
    const untouched = (await page.evaluate(request => window.callie.leads.list(request), listRequest)).rows.filter(row => row.personId !== id);
    expect(untouched.every(row => row.stage === 'unreviewed' && row.lastActivityAt === null)).toBe(true);
    const response = validEnrichmentEvent();
    response.entity.cloud_entity_id = event(selectedIndex).entity.cloud_entity_id;
    response.entity.person!.full_name = selected.personName;
    response.source_uri = `fixture:enrichment:${selectedIndex}`;
    response.observed_at = new Date().toISOString();
    await writeFile(join(directory, 'events', '2026-09-06', 'zzz-enrichment.ndjson'), JSON.stringify(cloudSourceEventSchema.parse(response)) + '\n');
    // Supply a controlled cloud result through the actual poller and mapper.
    // The selected inspector must notice new contacts without being rebuilt.
    const enrichmentPoll = await page.evaluate(() => window.callie.sourcing.pollNow());
    expect(enrichmentPoll.counters.imported).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const email = inspector.getByRole('button', { name: 'Email', exact: true });
    await expect(email).toBeVisible();
    expect((await page.evaluate(personId => window.callie.leadDetail.get({ personId }), id)).emails[0]).toMatchObject({ validationState: 'unverified', ownershipState: 'vendor_candidate' });
    await page.screenshot({ path: info.outputPath('selected-enrichment-email.png'), animations: 'disabled' });
    await email.click(); await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent synthetic draft');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Close draft' }).click(); await email.click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('Unsent synthetic draft');
    await page.getByRole('button', { name: 'Close draft' }).click();
    expect((await page.evaluate(personId => window.callie.discovery.getBrief({ personId }), id)).pilotNextStep).toBeNull();
    // Explicit founder-recorded actual conversation. Generated text never advances a stage.
    // Match the deliberately exact evidence grammar with the canonical stored street,
    // just as the assembled source test does. Intake lowercases property context.
    expect(ready.properties).toHaveLength(1);
    const street = ready.properties[0].address.split(', ')[0];
    expect(street).toBe(`${100 + selectedIndex} synthetic st`);
    const activityId = await page.evaluate(async ({ personId, salesCycleId, street }) => {
      await window.callie.today.logCallOutcome({ personId, salesCycleId, outcome: 'spoke', callbackAt: null, occurredAt: new Date().toISOString() });
      const spoken = (await window.callie.leadDetail.get({ personId })).activities[0];
      await window.callie.today.logPastActivity({ personId, salesCycleId, kind: 'call', direction: 'outbound',
        occurredAt: new Date().toISOString(), summary: 'I completed a synthetic discovery conversation.', outcome: 'answered' });
      const detail = await window.callie.leadDetail.get({ personId }); const activity = detail.activities.find(a => a.outcome === 'answered')!;
      await window.callie.conversations.attachTranscript({ personId, activityId: spoken.id, rawText: `Lead: I self-manage ${street}.` });
      await window.callie.leadDetail.confirmTransition({ transition: 'confirm_interviewed', salesCycleId, expectedRevision: detail.revision, suggestionActivityId: activity.id });
      return spoken.id;
    }, { personId: id, salesCycleId: selected!.salesCycleId, street });
    await expect.poll(() => page.evaluate(personId => window.callie.discovery.getBrief({ personId }), id), { timeout: 90_000 })
      .toMatchObject({ pilotNextStep: { activityIds: [activityId] } });
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await navigateFounderRoute(page, 'Leads');
    await page.getByRole('searchbox', { name: 'Search leads' }).fill(selected!.personName);
    // Search can legitimately include Owner 7 and Owner 74. Keep the exact saved identity.
    const selectedRow = page.locator(`[role="row"][data-person-id="${id}"]`);
    await expect(selectedRow.getByRole('checkbox', { name: `Select ${selected.personName}`, exact: true })).toBeVisible();
    await selectedRow.click();
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await page.getByRole('button', { name: 'Log dated past activity', exact: true }).click();
    await page.getByLabel('Date', { exact: true }).fill('2026-09-01');
    await page.getByLabel('What happened').fill('I stated the $50 supervised trial price in this synthetic conversation.');
    await page.getByRole('checkbox', { name: 'I stated the price' }).check();
    await page.getByRole('button', { name: 'Log activity', exact: true }).click();
    await expect.poll(() => page.evaluate(async personId => (await window.callie.leadDetail.get({ personId })).activities.some(a => a.outcome === 'price_said'), id)).toBe(true);
    await page.evaluate(async ({ personId, salesCycleId }) => {
      const detail = await window.callie.leadDetail.get({ personId }); const price = detail.activities.find(a => a.outcome === 'price_said')!;
      await window.callie.leadDetail.confirmTransition({ transition: 'confirm_offered', salesCycleId, expectedRevision: detail.revision, suggestionActivityId: price.id });
      await window.callie.today.logCallOutcome({ personId, salesCycleId, outcome: 'spoke', callbackAt: new Date(Date.now() + 1000).toISOString(), occurredAt: new Date().toISOString() });
    }, { personId: id, salesCycleId: selected!.salesCycleId });
    await expect.poll(() => page.evaluate(async () => (await window.callie.today.get()).lanes.flatMap(l => l.items)[0]?.personId)).toBe(id);
    const final = await page.evaluate(personId => window.callie.leadDetail.get({ personId }), id);
    expect(final.stage).toBe('offered'); // Not Won, a payment, or a booked meeting.
    await workspace.stop();
    workspace = await launchFounderWorkspace({ userDataPath: first.userDataPath, env: { CALLIE_SOURCING_FIXTURE_DIR: directory } });
    const reopened = await workspace.page.evaluate(personId => window.callie.leadDetail.get({ personId }), id);
    expect(reopened.activities).toEqual(final.activities); expect(reopened.nextAction).toEqual(final.nextAction);
    expect((await workspace.page.evaluate(request => window.callie.leads.list(request), listRequest)).total).toBe(125);
  } finally { await workspace?.stop(); await first?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('P2 same executable migrates nonzero16 to19, retains exact encrypted backup and intentional action changes', async () => {
  test.setTimeout(180_000);
  const fixtures = allocatePackagedFixtureDatabase(); let workspace: FounderWorkspace | undefined; let material = '';
  try {
    workspace = await launchFounderWorkspace({ userDataPath: fixtures.paths.bootstrap, onSpawn: child => { fixtures.captureChild(child); } });
    // Only explicitly revealed material for this isolated synthetic bootstrap, never real keys or logging.
    material = await workspace.page.evaluate(async () => (await window.callie.recovery.beginSetup({ founderConfirmed: true })).material);
    await workspace.stop(); workspace = undefined; // Bounded termination only. Native normal Quit remains root-owned.
    await fixtures.captureBootstrapEnvelope(); const original = await fixtures.createThrough16Profile(material);
    expect(original.schemaVersion).toBe(16); expect(original.aggregateCounts).toEqual({ people: 2, prospects: 2, sourceEvents: 2 });
    expect(original.ledger.at(-1)).toBe('0016ContactPresentationEvidence');
    const launch = () => launchFounderWorkspace({ userDataPath: fixtures.paths.through16, onSpawn: child => { fixtures.captureChild(child); } });
    workspace = await launch();
    expect(await workspace.page.evaluate(() => window.callie.health.get())).toMatchObject({ schemaVersion: 25, databaseEncrypted: true, domainReady: true });
    await expect.poll(() => workspace!.page.evaluate(() => window.callie.discovery.get()), { timeout: 90_000 }).toMatchObject({ counts: { unassessed: 0 }, processing: 'idle' });
    const assessed = await workspace.page.evaluate(request => window.callie.leads.list(request), listRequest);
    expect(assessed.rows.every(row => row.stage === 'unreviewed' && row.lastActivityAt === null)).toBe(true);
    const actions = await workspace.page.evaluate(async people => Promise.all(people.map(personId => window.callie.leadDetail.get({ personId }))), assessed.rows.map(row => row.personId));
    expect(actions.every(detail => detail.nextAction?.dueAt != null)).toBe(true);
    const ids = (await workspace.page.evaluate(() => window.callie.discovery.get())).prepared.map(b => b.assessment!.id);
    expect(ids).toHaveLength(2);
    await workspace.stop(); workspace = undefined;
    const names = (await readdir(join(fixtures.paths.through16, 'backups'))).filter(name => name.startsWith('pre-migration-schema-16-'));
    expect(names).toHaveLength(1); const backupPath = join(fixtures.paths.through16, 'backups', names[0]); const retainedHash = await sha256(backupPath);
    const backup = await fixtures.inspectStoppedBackup('through16', names[0], material, 16);
    expect(backup.businessSha256).toBe(original.businessSha256); // SAME schema only
    expect(backup.aggregateCounts).toEqual(original.aggregateCounts); expect(backup.sourceSha256).toBe(retainedHash);
    const migrated = await fixtures.inspectStoppedProfile('through16', material, 25);
    expect(migrated.preservedActionIndependentSha256).toBe(original.preservedActionIndependentSha256);
    expect(migrated.ledger.slice(-10)).toEqual(['0016ContactPresentationEvidence', '0017DiscoveryAssessments', '0018PlaybookDueActions', '0019EmailDrafts', '0020PmAccounts', '0021DelegatedWork', '0022MailPersistence', '0023Campaigns', '0024RequestedFollowupAndPolicyReviews', '0025KnownCompanyResearchSettings']);
    workspace = await launch();
    expect((await workspace.page.evaluate(() => window.callie.discovery.get())).prepared.map(b => b.assessment!.id)).toEqual(ids);
    await workspace.stop(); workspace = undefined;
    expect(await sha256(backupPath)).toBe(retainedHash);
    expect((await fixtures.inspectStoppedProfile('through16', material, 25)).preservedActionIndependentSha256).toBe(original.preservedActionIndependentSha256);
    expect((await readdir(join(fixtures.paths.through16, 'backups'))).filter(name => name.startsWith('pre-migration-schema-16-'))).toEqual(names);
  } finally { material = ''; await workspace?.stop(); await fixtures.cleanup(); }
});
