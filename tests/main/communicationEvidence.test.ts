import { logPastActivityRequestSchema, logCallOutcomeRequestSchema } from '../../src/shared/contracts/todayContract';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { isLegacyOutboundRequest, isOutboundCommandFact } from '../../src/main/domain/events/communicationEvidence';
import { insertOpenCycleWithAction, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const authority = { authorizationPolicyVersion: 'outbound_compliance_v1', authorizationReason: 'allowed' };
const legacy: Parameters<typeof isLegacyOutboundRequest>[0] & { channel: string } = {
  kind: 'call', direction: 'outbound', channel: 'phone', observedOutcome: null,
  adapter: null, providerIdempotencyKey: null, providerReference: null, durationSeconds: null,
  recordingStorageRef: null, transcriptStorageRef: null, callOutcome: null, metadata: authority,
};
const controls = [
  ...['call', 'text', 'email'].map((kind) => ({ name: kind, patch: { kind }, hidden: true })),
  ...['kind', 'direction', 'observedOutcome', 'adapter', 'providerIdempotencyKey', 'providerReference',
    'durationSeconds', 'recordingStorageRef', 'transcriptStorageRef', 'callOutcome'].map((field) => ({
    name: field, patch: { [field]: field === 'kind' ? 'note' : field === 'direction' ? 'inbound'
      : field === 'durationSeconds' ? 0 : 'evidence' }, hidden: false,
  })),
  ...[null, [], {}, 'not metadata', { summary: 'manual, sent' }, { ...authority, loggedManually: true },
    { ...authority, authorizationReason: 'denied' }, { authorizationReason: 'allowed' },
    { ...authority, authorizationPolicyVersion: null }].map((metadata, i) => ({
    name: `metadata ${i}`, patch: { metadata }, hidden: false,
  })),
];

describe('communication evidence classifiers', () => {
  it.each(controls)('classifies $name without inventing occurrence', ({ patch, hidden }) => {
    expect(isLegacyOutboundRequest({ ...legacy, ...patch })).toBe(hidden);
  });
  it('does not accept inherited authorization keys as the exact legacy metadata', () => {
    const metadata = Object.assign(Object.create(authority), { other: true, extra: true });
    expect(isLegacyOutboundRequest({ ...legacy, metadata })).toBe(false);
  });
  it('requires every exact command discriminator, not unrelated system activity', () => {
    const command = { kind: 'system', direction: 'internal', channel: 'outbound_command', adapter: 'callie_outbound_v1' };
    expect(isOutboundCommandFact(command)).toBe(true);
    for (const field of Object.keys(command)) {
      expect(isOutboundCommandFact({ ...command, [field]: null })).toBe(false);
      expect(isOutboundCommandFact({ ...command, [field]: 'other' })).toBe(false);
    }
  });
});

describe('encrypted SQL and TypeScript recency parity', () => {
  let temp: TempDatabase;
  let database: AppDatabase;
  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  });
  afterEach(() => { closeDatabase(database); temp.cleanup(); });

  it('preserves ordinary manual/provider/note/system recency and source rows while excluding only exact requests', () => {
    let sequence = 0;
    const clock = { now: () => '2026-09-06T16:00:00.000Z' };
    const ids = { next: () => `event-${++sequence}` };
    const services = createDomainServices({ database, clock, ids });
    const domain = createFounderSalesDomain({ database, services, clock, ids });
    const cases = [...controls,
      { name: 'command', patch: { kind: 'system', direction: 'internal', channel: 'outbound_command', adapter: 'callie_outbound_v1', metadata: {} }, hidden: true },
      { name: 'unrelated system', patch: { kind: 'system', direction: 'internal', metadata: {} }, hidden: false },
      { name: 'duplicate JSON key last value', patch: { metadata: authority }, hidden: true },
      { name: 'malformed metadata', patch: { metadata: '{' }, hidden: false },
    ];
    for (const [i, test] of cases.entries()) {
      const prefix = `parity-${i}`;
      const owner = seedProspect(database.raw, prefix);
      const { cycleId } = insertOpenCycleWithAction({ database: database.raw, prefix, prospect: owner });
      const activity = { ...legacy, ...test.patch };
      // Respect the real schema's provider-key and structured-call constraints.
      if (activity.providerIdempotencyKey !== null) activity.adapter = 'provider';
      if (activity.callOutcome !== null) activity.callOutcome = 'no_answer';
      const consentId = activity.recordingStorageRef !== null || activity.transcriptStorageRef !== null
        ? services.unitOfWork.immediate(() => services.events.appendConsentPolicyRecord({
          personId: owner.personId, policyKind: 'recording', policyVersion: 'fixture',
          effectiveAt: clock.now(), decision: 'granted', evidence: { fixture: true },
        })).id : null;
      const metadataJson = test.name === 'malformed metadata' ? '{'
        : test.name === 'duplicate JSON key last value'
          ? '{"authorizationReason":"denied","authorizationPolicyVersion":"outbound_compliance_v1","authorizationReason":"allowed"}'
          : JSON.stringify(activity.metadata);
      database.raw.prepare(`INSERT INTO activities (id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,
        occurred_at,created_at,metadata_json,observed_outcome,adapter,provider_idempotency_key,provider_reference,
        duration_seconds,recording_storage_ref,transcript_storage_ref,call_outcome,consent_policy_record_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(prefix, owner.personId, owner.prospectId, cycleId,
        activity.kind, activity.direction, activity.channel, clock.now(), clock.now(), metadataJson,
        activity.observedOutcome, activity.adapter, activity.providerIdempotencyKey, activity.providerReference,
        activity.durationSeconds, activity.recordingStorageRef, activity.transcriptStorageRef, activity.callOutcome, consentId);
      const before = database.raw.prepare('SELECT * FROM activities WHERE id = ?').get(prefix);
      const row = domain.listLeadRows({ query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 100 })
        .rows.find((item) => item.personId === owner.personId)!;
      expect(row.lastActivityAt, test.name).toBe(test.hidden ? null : clock.now());
      const candidate = services.todayRepository.listOperationalCandidates().find((item) => item.kind === 'candidate' && item.candidate.personId === owner.personId);
      expect(candidate, test.name).toMatchObject({ kind: 'candidate', candidate: { lastActivity: test.hidden ? null : { id: prefix } } });
      const detail = domain.getLeadDetail({ personId: owner.personId });
      if (test.name === 'command') expect(detail.activities).toEqual([]);
      else if (test.hidden) expect(detail.activities).toEqual([expect.objectContaining({ kind: 'system', summary: 'Legacy outbound request, occurrence unverified' })]);
      else expect(detail.activities[0].kind, test.name).toBe(activity.kind);
      expect(database.raw.prepare('SELECT * FROM activities WHERE id = ?').get(prefix)).toEqual(before);
    }
  });
});

describe('strict optional manual command association contracts', () => {
  const commandId = '00000000-0000-4000-8000-000000000001';
  const common = { personId: 'person', salesCycleId: 'cycle', occurredAt: '2026-09-06T16:00:00.000Z', outcome: 'no_answer' };
  const cases = [
    { name: 'past activity', schema: logPastActivityRequestSchema, request: { ...common, kind: 'call', direction: 'outbound', summary: 'Manual report' } },
    { name: 'call outcome', schema: logCallOutcomeRequestSchema, request: { ...common, callbackAt: null as string | null } },
  ];
  it.each(cases)('keeps old $name callers valid and accepts only UUID command associations', ({ schema, request }) => {
    expect(schema.safeParse(request).success).toBe(true);
    expect(schema.safeParse({ ...request, outboundCommandId: commandId }).success).toBe(true);
    expect(schema.safeParse({ ...request, outboundCommandId: 'not-a-command' }).success).toBe(false);
    for (const forbidden of ['canonicalPhone', 'target', 'authorization', 'providerReference', 'metadata']) {
      expect(schema.safeParse({ ...request, outboundCommandId: commandId, [forbidden]: 'caller value' }).success).toBe(false);
    }
  });
});
