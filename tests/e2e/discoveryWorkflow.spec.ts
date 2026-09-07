import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'playwright/test';
import { launchFounderWorkspace, type FounderWorkspace } from '../support/founderWorkspace';
import { allocatePackagedFixtureDatabase } from '../support/packagedFixtureDatabase';
import { validParcelEvent } from '../fixtures/cloudSourceEvents';
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
  value.entity.person!.emails = index === 0 ? ['owner0@example.test'] : [];
  value.entity.property!.situs_address.line1 = `${100 + index} Synthetic St`;
  value.entity.property!.parcel_id = `PACKAGED-SYNTHETIC-${index}`;
  value.entity.property!.unit_count = index % 10 === 9 ? null : index % 2 === 0 ? 10 : 6;
  value.entity.property!.year_built = index % 10 === 9 ? null : index % 2 === 0 ? 1918 : 1970;
  value.source_uri = `fixture:discovery:${index}`;
  return cloudSourceEventSchema.parse(value);
}

test('P1 automatic source-backed shortlist, unfinished-work restart, evidence, selected manual pilot and unsent draft', async () => {
  test.setTimeout(240_000); // Real worker's bounded minute scan, never a test repair API.
  const directory = await mkdtemp(join(tmpdir(), 'callie-discovery-inbox-'));
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
    await page.getByRole('button', { name: 'Refresh shortlist' }).click();
    await expect(page.getByRole('heading', { name: 'Prepared conversations' })).toBeVisible();
    await expect(page.getByText('Additional research not configured')).toBeVisible();
    const selected = snapshot.prepared.find(b => b.personName === 'Synthetic 0 Holdings LLC');
    expect(selected).toBeDefined();
    const id = selected!.personId;
    const before = await page.evaluate(request => window.callie.leads.list(request), listRequest);
    expect(before.rows).toHaveLength(125); expect(before.rows.every(row => row.stage === 'unreviewed' && row.lastActivityAt === null)).toBe(true);
    await page.getByRole('button', { name: `View evidence for ${selected!.personName}`, exact: true }).click();
    const inspector = page.getByRole('article', { name: `${selected!.personName} full page` });
    const ref = selected!.assessment!.claims.flatMap(c => c.refs).find(ref => ref.kind === 'source')!;
    if (ref.kind !== 'source') throw new Error('Expected retained source citation');
    await expect(inspector.getByText(`Source ${ref.sourceEventId}, ${ref.field}, ${ref.observedAt}`, { exact: true }).first()).toBeVisible();
    expect((await page.evaluate(personId => window.callie.leadDetail.get({ personId }), id)).stage).toBe('unreviewed');
    await inspector.getByRole('button', { name: 'Close inspector' }).click();
    await page.getByRole('button', { name: `Contact options for ${selected!.personName}`, exact: true }).click();
    await expect.poll(() => page.evaluate(personId => window.callie.leadDetail.get({ personId }), id)).toMatchObject({ stage: 'ready' });
    const ready = await page.evaluate(personId => window.callie.leadDetail.get({ personId }), id);
    expect(ready.activities).toEqual([]); expect(ready.nextAction).not.toBeNull();
    const untouched = (await page.evaluate(request => window.callie.leads.list(request), listRequest)).rows.filter(row => row.personId !== id);
    expect(untouched.every(row => row.stage === 'unreviewed' && row.lastActivityAt === null)).toBe(true);
    const email = page.getByRole('button', { name: 'Email owner0@example.test' });
    await email.click(); await page.getByLabel('Message', { exact: true }).fill('Unsent synthetic draft');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Close draft' }).click(); await email.click();
    await expect(page.getByLabel('Message', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Close draft' }).click();
    expect((await page.evaluate(personId => window.callie.discovery.getBrief({ personId }), id)).pilotNextStep).toBeNull();
    // Explicit founder-recorded actual conversation. Generated text never advances a stage.
    const activityId = await page.evaluate(async ({ personId, salesCycleId }) => {
      await window.callie.today.logCallOutcome({ personId, salesCycleId, outcome: 'spoke', callbackAt: null, occurredAt: new Date().toISOString() });
      const spoken = (await window.callie.leadDetail.get({ personId })).activities[0];
      await window.callie.today.logPastActivity({ personId, salesCycleId, kind: 'call', direction: 'outbound',
        occurredAt: new Date().toISOString(), summary: 'I completed a synthetic discovery conversation.', outcome: 'answered' });
      const detail = await window.callie.leadDetail.get({ personId }); const activity = detail.activities.find(a => a.outcome === 'answered')!;
      await window.callie.conversations.attachTranscript({ personId, activityId: spoken.id, rawText: 'Lead: I self-manage 100 Synthetic St.' });
      await window.callie.leadDetail.confirmTransition({ transition: 'confirm_interviewed', salesCycleId, expectedRevision: detail.revision, suggestionActivityId: activity.id });
      return spoken.id;
    }, { personId: id, salesCycleId: selected!.salesCycleId });
    await expect.poll(() => page.evaluate(personId => window.callie.discovery.getBrief({ personId }), id), { timeout: 90_000 })
      .toMatchObject({ pilotNextStep: { activityIds: [activityId] } });
    await page.getByRole('button', { name: 'Close inspector' }).click();
    await page.getByRole('link', { name: 'Leads', exact: true }).click();
    await page.getByRole('row', { name: /Synthetic 0 Holdings/i }).click();
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

test('P2 same executable migrates nonzero16, retains exact encrypted16 backup and preserves the named untouched subset', async () => {
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
    expect(await workspace.page.evaluate(() => window.callie.health.get())).toMatchObject({ schemaVersion: 17, databaseEncrypted: true, domainReady: true });
    await expect.poll(() => workspace!.page.evaluate(() => window.callie.discovery.get()), { timeout: 90_000 }).toMatchObject({ counts: { unassessed: 0 }, processing: 'idle' });
    const assessed = await workspace.page.evaluate(request => window.callie.leads.list(request), listRequest);
    expect(assessed.rows.every(row => row.stage === 'unreviewed' && row.lastActivityAt === null)).toBe(true);
    const ids = (await workspace.page.evaluate(() => window.callie.discovery.get())).prepared.map(b => b.assessment!.id);
    expect(ids).toHaveLength(2);
    await workspace.stop(); workspace = undefined;
    const names = (await readdir(join(fixtures.paths.through16, 'backups'))).filter(name => name.startsWith('pre-migration-schema-16-'));
    expect(names).toHaveLength(1); const backupPath = join(fixtures.paths.through16, 'backups', names[0]); const retainedHash = await sha256(backupPath);
    const backup = await fixtures.inspectStoppedBackup('through16', names[0], material, 16);
    expect(backup.businessSha256).toBe(original.businessSha256); // SAME schema only
    expect(backup.aggregateCounts).toEqual(original.aggregateCounts); expect(backup.sourceSha256).toBe(retainedHash);
    const migrated = await fixtures.inspectStoppedProfile('through16', material, 17);
    expect(migrated.preserved16Sha256).toBe(original.preserved16Sha256);
    expect(migrated.ledger.slice(-2)).toEqual(['0016ContactPresentationEvidence', '0017DiscoveryAssessments']);
    workspace = await launch();
    expect((await workspace.page.evaluate(() => window.callie.discovery.get())).prepared.map(b => b.assessment!.id)).toEqual(ids);
    await workspace.stop(); workspace = undefined;
    expect(await sha256(backupPath)).toBe(retainedHash);
    expect((await fixtures.inspectStoppedProfile('through16', material, 17)).preserved16Sha256).toBe(original.preserved16Sha256);
    expect((await readdir(join(fixtures.paths.through16, 'backups'))).filter(name => name.startsWith('pre-migration-schema-16-'))).toEqual(names);
  } finally { material = ''; await workspace?.stop(); await fixtures.cleanup(); }
});
