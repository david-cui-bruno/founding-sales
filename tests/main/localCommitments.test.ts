import { randomUUID } from 'node:crypto';
import { localCommitmentsSnapshotSchema } from '../../src/shared/contracts/localWorkspaceContract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain, type FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';
import { DOMAIN_TIMESTAMP, insertOpenCycleWithAction, seedProspect } from '../fixtures/domainRows';
const at = '2026-09-09T15:00:00.000Z';
describe('local retained Today feed', () => {
  let database: AppDatabase, temp: TempDatabase, domain: FounderSalesDomain;
  beforeEach(async () => {
    temp = createTempDatabase(); const key = createTestWorkspaceKey(); database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const clock = { now: () => at }, ids = { next: () => 'unused' };
    const services = createDomainServices({ database, clock, ids });
    domain = createFounderSalesDomain({ database, clock, ids, services });
  });
  afterEach(() => { closeDatabase(database); temp.cleanup(); });
  function seed(prefix: string, stage: 'contacted' | 'interviewed' = 'contacted') {
    const prospect = seedProspect(database.raw, prefix);
    database.raw.prepare("UPDATE prospects SET segment='cold' WHERE id=?").run(prospect.prospectId);
    const cycle = insertOpenCycleWithAction({ database: database.raw, prefix, prospect, stage });
    database.raw.prepare("UPDATE next_actions SET due_at=?,due_source='recorded_callback' WHERE id=?").run(at, cycle.actionId);
    return { ...prospect, ...cycle };
  }
  it('retains evidenced callbacks, post-stage and warm work but not a bare promise label, before and after transition', () => {
    const callback = seed('callback'), warm = seed('warm'), post = seed('post', 'interviewed'); seed('unproven');
    database.raw.prepare("UPDATE prospects SET segment='warm' WHERE id=?").run(warm.prospectId);
    database.raw.prepare(`INSERT INTO activities (id, person_id, prospect_id, sales_cycle_id, kind, direction, channel, occurred_at, observed_outcome, callback_at, created_at, metadata_json)
      VALUES ('promise',?,?,?,'call','outbound','phone',?,'spoke',?,?,'{}')`).run(callback.personId, callback.prospectId, callback.cycleId, DOMAIN_TIMESTAMP, at, DOMAIN_TIMESTAMP);
    const before = database.raw.prepare('SELECT total_changes() AS count').get();
    const result = domain.getLocalCommitments();
    expect(result.items.map(r => [r.kind, r.item.action.id])).toEqual([
      ['post_stage', post.actionId], ['callback', callback.actionId], ['warm_relationship', warm.actionId],
    ]);
    expect(result.items.find(r => r.kind === 'callback')?.item.action.dueAt).toBe(at);
    expect(localCommitmentsSnapshotSchema.safeParse({ ...result, items: [{ ...result.items[0], item: { ...result.items[0].item, salesCycleId: 'foreign-cycle' } }] }).success).toBe(false);
    expect(localCommitmentsSnapshotSchema.safeParse({ ...result, items: [result.items[0], result.items[0]] }).success).toBe(false);
    expect(localCommitmentsSnapshotSchema.safeParse({ ...result, reviewErrorCount: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(database.raw.inTransaction).toBe(false);

    expect(result.items.map(r => r.item)).toEqual(domain.getToday().lanes.flatMap(l => l.items).filter(i => i.action.id !== 'unproven-action'));
    expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    domain.transitionWorkflow({ commandId: 'transition', manifestId: 'manifest', expectedMode: 'legacy' });
    expect(domain.getLocalCommitments().items).toEqual(result.items);
  });
  function operational(prefix: string, intent: 'inbound_response' | 'promised_follow_up' = 'promised_follow_up') {
    const prospect = seedProspect(database.raw, prefix);
    database.raw.prepare("UPDATE prospects SET segment='cold' WHERE id=?").run(prospect.prospectId);
    database.raw.transaction(() => {
      database.raw.prepare(`INSERT INTO sales_cycles (id,person_id,prospect_id,entry_source_event_id,stage,workflow_status,current_next_action_id,stage_entered_at,version,created_at,updated_at)
        VALUES (?,?,?,?,'contacted','active',?,?,1,?,?)`).run(`${prefix}-cycle`, prospect.personId, prospect.prospectId, prospect.sourceEventId, `${prefix}-action`, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      database.raw.prepare(`INSERT INTO next_actions (id,sales_cycle_id,action_type,channel,status,timezone,work_intent,due_at,due_source,created_at)
        VALUES (?,?,'call','phone','pending','America/New_York',?,?,'recorded_callback',?)`).run(`${prefix}-action`, `${prefix}-cycle`, intent, at, DOMAIN_TIMESTAMP);
    }).immediate();
    return { ...prospect, cycleId: `${prefix}-cycle`, actionId: `${prefix}-action` };
  }
  it('tags onboarding and inbound ahead of weaker evidence and retains exact lane ordering', () => {
    const onboard = operational('onboard'), inbound = operational('inbound', 'inbound_response');
    database.raw.prepare("UPDATE sales_cycles SET stage='won',workflow_status='onboarding' WHERE id=?").run(onboard.cycleId);
    const result = domain.getLocalCommitments();
    expect(result.items.map(r => [r.kind, r.item.action.id, r.item.lane])).toEqual([
      ['onboarding', onboard.actionId, 'onboarding'], ['inbound_response', inbound.actionId, 'fresh_inbound'],
    ]);
  });
  it('retains due founder return in later without promoting unproven automatic promises', () => {
    const founder = operational('founder'); operational('unproven');
    database.raw.prepare('UPDATE workspace_settings SET daily_dial_capacity=0').run();
    database.raw.prepare("UPDATE sales_cycles SET resurface_at=?,resurface_reason='snooze' WHERE id=?").run(at, founder.cycleId);
    const result = domain.getLocalCommitments();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: 'founder_resurface', item: { id: founder.cycleId, salesCycleId: founder.cycleId, lane: 'later', reason: 'capacity_overflow', action: { id: founder.actionId, dueAt: at } } });
    expect(result.items[0].item).toEqual(domain.getToday().lanes.flatMap(l => l.items).find(i => i.id === founder.cycleId));
  });
  it('excludes future, opted-out and deleted work and preserves corruption diagnostics', () => {
    const future = seed('future', 'interviewed'), opted = seed('opted', 'contacted'), deleted = seed('deleted', 'interviewed'), malformed = seed('malformed', 'interviewed');
    database.raw.prepare('UPDATE next_actions SET due_at=? WHERE id=?').run('2026-09-11T15:00:00.000Z', future.actionId);
    database.raw.prepare(`INSERT INTO activities (id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,created_at,metadata_json,observed_outcome)
      VALUES ('opt-source',?,?,?,'system','internal','manual',?,?,'{}','opted_out')`).run(opted.personId, opted.prospectId, opted.cycleId, at, at);
    createDomainServices({ database, clock: { now: () => at }, ids: { next: () => 'opt-allocated' } }).optOut.apply({
      personId: opted.personId, tombstoneId: 'tombstone', requestedAt: at, policyVersion: 'founder_opt_out_v1',
      decision: { kind: 'founder_confirmed', channel: 'manual' }, evidence: { kind: 'existing_activity', activityId: 'opt-source' }, terminalStageEventId: 'opt-terminal',
    });
    database.raw.prepare('UPDATE persons SET deleted_at=? WHERE id=?').run(at, deleted.personId);
    database.raw.prepare("UPDATE sales_cycles SET resurface_at='not-an-instant',resurface_reason='snooze' WHERE id=?").run(malformed.cycleId);
    const result = domain.getLocalCommitments();
    expect(result.items).toEqual([]);
    expect(result.reviewErrorCount).toBeGreaterThan(0);
    expect(result.reviewErrorCount).toBe(domain.getToday().reviewErrorCount);
  });
  it('classifies an earlier independent non-call post-stage due separately from a future callback', () => {
    const post = seed('early-post', 'interviewed');
    database.raw.prepare(`INSERT INTO activities (id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,observed_outcome,callback_at,created_at,metadata_json)
      VALUES ('future-promise',?,?,?,'call','outbound','phone',?,'spoke',?,?,'{}')`).run(post.personId, post.prospectId, post.cycleId, DOMAIN_TIMESTAMP, '2026-09-11T15:00:00.000Z', DOMAIN_TIMESTAMP);
    expect(domain.getLocalCommitments().items).toMatchObject([{ kind: 'post_stage', item: { action: { id: post.actionId, dueAt: at } } }]);
  });

  it('does not resurrect manifest-parked legacy review work', () => {
    const prospect = seedProspect(database.raw, 'parked');
    database.raw.prepare("UPDATE prospects SET qualification_state='unreviewed',segment='cold' WHERE id=?").run(prospect.prospectId);
    let allocated = 0;
    const services = createDomainServices({ database, clock: { now: () => at }, ids: { next: () => `parked-${++allocated}` } });
    const cycle = services.lifecycle.createUnreviewedCycle({ personId: prospect.personId, prospectId: prospect.prospectId, entrySourceEventId: prospect.sourceEventId, effectiveAt: at });
    const receipt = domain.transitionWorkflow({ commandId: 'park-command', manifestId: 'park-manifest', expectedMode: 'legacy' });
    expect(receipt.parkedReviewActions.map(a => a.cycleId)).toContain(cycle.id);
    expect(domain.getLocalCommitments().items).toEqual([]);
  });

  it('lists an unsent local company draft as an additive local draft continuation, never as a person item', () => {
    // Real repository seam: a Lenox-shaped saved source, one reviewed business inbox, one opened draft, one saved edit.
    const clock = { now: () => at }, ids = { next: randomUUID };
    const accounts = new AccountRepository({ database, clock, ids, sourcePolicy: { attest: () => true } });
    const account = accounts.create({ commandId: randomUUID(), name: 'Lenox Management', domain: 'lenoxmanagement.com' });
    const sourceId = randomUUID();
    const quote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
    accounts.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: account.version, sources: [{ id: sourceId,
      url: 'https://lenoxmanagement.com/', fetchedAt: at, sha256: 'b'.repeat(64), excerpt: quote, permitted: true }], claims: [], routes: [] });
    const local = createFounderSalesDomain({ database, clock, ids, services: createDomainServices({ database, clock, ids }) });
    const admitted = local.admitCompanyDraftEmail({ commandId: randomUUID(), accountId: account.id, expectedAccountVersion: account.version + 1,
      email: 'info@lenoxmanagement.com', sourceId, quote, selection: 'published_company_business_inbox' });
    const opened = local.openCompanyDraft({ commandId: randomUUID(), accountId: account.id, routeId: admitted.recipientBinding.routeId,
      expectedRouteVersion: admitted.recipientBinding.routeVersion, expectedAccountVersion: admitted.accountVersion });
    local.saveCompanyDraft({ commandId: randomUUID(), accountId: account.id, draftId: opened.current.draft.id, expectedRevision: 1,
      subject: 'Maintenance request coordination at Lenox', body: 'Hello Lenox Management team,' });
    const before = database.raw.prepare('SELECT total_changes() AS count').get();
    const result = domain.getLocalCommitments();
    expect(result.items).toEqual([]);
    expect(result.localDrafts).toEqual([{ accountId: account.id, draftId: opened.current.draft.id, companyLabel: 'Lenox Management',
      subject: 'Maintenance request coordination at Lenox', revision: 2, updatedAt: at, email: 'info@lenoxmanagement.com' }]);
    expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    expect(database.raw.inTransaction).toBe(false);
    // Additive and optional: a snapshot without the field keeps parsing; duplicate draft identities do not.
    const { localDrafts, ...withoutDrafts } = result;
    expect(localCommitmentsSnapshotSchema.safeParse(withoutDrafts).success).toBe(true);
    expect(localCommitmentsSnapshotSchema.safeParse({ ...result, localDrafts: [localDrafts![0], localDrafts![0]] }).success).toBe(false);
  });

});
