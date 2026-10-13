import { setTimeout as delay } from 'node:timers/promises';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { correctRelationship } from '@fss/domain/crm/relationships.ts';
import { changeSelectedSource } from '@fss/domain/crm/people.ts';
import { correctEndpoint } from '@fss/domain/crm/endpoints.ts';
import { reassignFirm } from '@fss/domain/crm/firms.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

let fixture: AuthFixture;
let token: string;
const command = (fields: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
const post = (path: string, body: unknown, bearer = token) => dispatch({ method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${bearer}` }, body }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, suppressionJournal: { append: async () => {} }, sendingEnabled: false });
beforeAll(async () => { fixture = await createAuthFixture(); token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken; });
afterAll(async () => fixture.stop());

async function supportedRoute(options: { fullName?: string; profile?: string; excerpt?: (name: string, firm: string, profile: string) => string; firmId?: string } = {}) {
  const name = options.fullName ?? 'Taylor Park';
  const firmName = `Harbor ${randomUUID()}`;
  const firmId = options.firmId ?? await seedFirm(fixture, { name: firmName, locality: 'Providence', regionCode: 'RI', assignedUserId: fixture.alpha.salesperson.userId });
  const actualFirmName = (await fixture.db.query<{ name: string }>('SELECT name FROM firms WHERE workspace_id=$1 AND id=$2', [fixture.alpha.workspaceId, firmId])).rows[0]!.name;
  const personId = ((await post('/crm/people/create', command({ fullName: name }))).body as { result: { personId: string } }).result.personId;
  const profile = options.profile ?? `https://www.linkedin.com/in/person-${randomUUID()}`;
  const text = options.excerpt?.(name, actualFirmName, profile) ?? `${name} is the owner of ${actualFirmName}. ${name}'s LinkedIn profile is ${profile}.\n${actualFirmName} is an independent residential property management firm serving Providence, Rhode Island.`;
  const sourceKey = randomUUID();
  await post('/crm/people/source/add', command({ personId, sourceKey, excerpt: text, occurredAt: '2026-10-13T14:00:00.000Z' }));
  const source = ((await post('/crm/people/read', { personId })).body as { sources: { sourceId: string; revision: number; contentHash: string }[] }).sources[0]!;
  const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
  const relationshipId = ((await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }))).body as { result: { relationshipId: string } }).result.relationshipId;
  const claim = await post('/crm/endpoints/claim', command({ personId, firmId: null, kind: 'linkedin', value: profile, shared: false, status: 'current', startDate: null, endDate: null, evidence }));
  expect(claim.status).toBe(200);
  return { personId, sourceKey, text, firmId, firmName: actualFirmName, profile, evidence, relationshipId, ...(claim.body as { result: { claimId: string; endpointId: string } }).result };
}

it('does not turn cooccurring display names and someone else\'s profile or role into identity support', async () => {
  for (const variant of ['profile', 'role']) {
    const route = await supportedRoute({ excerpt: (name, firm, profile) => variant === 'profile'
      ? `${name} is the owner of ${firm}. Jordan Fields's LinkedIn profile is ${profile}.\n${firm} is an independent residential property management firm serving Providence, Rhode Island.`
      : `${name} knows Jordan Fields, the owner of ${firm}. ${name}'s LinkedIn profile is ${profile}.\n${firm} is an independent residential property management firm serving Providence, Rhode Island.` });
    expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', route: null, reason: variant === 'profile' ? 'profile_identity_unsupported' : 'role_or_firm_unsupported' });
  }
});

it('keeps duplicate profiles and several plausible current relationships reviewable', async () => {
  const first = await supportedRoute();
  const second = await supportedRoute({ profile: first.profile });
  expect(second.endpointId).toBe(first.endpointId);
  expect((await post('/crm/linkedin/routes/assess', { claimId: first.claimId })).body).toMatchObject({ state: 'held', reason: 'duplicate_profile', route: null });
  const ambiguous = await supportedRoute();
  const firmId = await seedFirm(fixture, { name: 'Another relationship firm', assignedUserId: fixture.alpha.salesperson.userId });
  await post('/crm/relationships/save', command({ personId: ambiguous.personId, firmId, status: 'current', startDate: null, endDate: null, evidence: ambiguous.evidence }));
  expect((await post('/crm/linkedin/routes/assess', { claimId: ambiguous.claimId })).body).toMatchObject({ state: 'held', reason: 'relationship_needs_review', route: null });
});

it('records person, firm and ambiguous refusal scopes through the caller and prevents a referral bypass', async () => {
  for (const scope of ['person', 'firm', 'ambiguous']) {
    const first = await supportedRoute();
    const referral = await supportedRoute({ firmId: first.firmId });
    const stopped = await post('/crm/linkedin/routes/refuse', command({ claimId: first.claimId, expectedRevision: 1, firmId: first.firmId, relationshipId: first.relationshipId, expectedRelationshipRevision: 1, scope }));
    expect(stopped.status).toBe(200);
    expect((await post('/crm/linkedin/routes/assess', { claimId: first.claimId })).body).toMatchObject({ state: 'held', reason: scope === 'ambiguous' ? 'refusal_scope_needs_review' : 'person_or_firm_stopped' });
    expect((await post('/crm/linkedin/routes/assess', { claimId: referral.claimId })).body).toMatchObject(scope === 'person' ? { state: 'eligible' } : { state: 'held', reason: scope === 'ambiguous' ? 'refusal_scope_needs_review' : 'person_or_firm_stopped' });
  }
});

it('rejects cross-workspace and non-owner reads and commands, not merely unauthenticated callers', async () => {
  const route = await supportedRoute();
  const betaToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.salesperson)).accessToken;
  const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  await fixture.database.session.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'salesperson')", [fixture.alpha.workspaceId, fixture.beta.salesperson.userId]);
  const otherToken = (await issueSessionFor(fixture, fixture.alpha, fixture.beta.salesperson)).accessToken;
  for (const bearer of [betaToken, otherToken, adminToken]) {
    if (bearer === adminToken) {
      // Admin exceptional reads are allowed and audited by identity, but source ownership is not transferred.
      expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId }, bearer)).status).toBe(200);
      expect((await fixture.db.query('SELECT id FROM audit_events WHERE workspace_id=$1 AND action=$2 AND subject_id=$3', [fixture.alpha.workspaceId, 'crm.linkedin_private_evidence_read', route.evidence.sourceId])).rows).toHaveLength(1);
      continue;
    }
    expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId }, bearer)).status).toBe(404);
    expect((await post('/crm/linkedin/routes/refuse', command({ claimId: route.claimId, expectedRevision: 1, firmId: route.firmId, relationshipId: route.relationshipId, expectedRelationshipRevision: 1, scope: 'firm' }), bearer)).status).toBe(409);
  }
  await reassignFirm(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), fixture.db), { firmId: route.firmId, toUserId: fixture.alpha.admin.userId });
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).status).toBe(404);
  expect((await post('/crm/linkedin/routes/refuse', command({ claimId: route.claimId, expectedRevision: 1, firmId: route.firmId, relationshipId: route.relationshipId, expectedRelationshipRevision: 1, scope: 'firm' }))).status).toBe(409);
});

it('requires source-bound identity, not an identically named Person using another selected source', async () => {
  const first = await supportedRoute();
  const personId = ((await post('/crm/people/create', command({ fullName: 'Taylor Park' }))).body as { result: { personId: string } }).result.personId;
  const relation = await post('/crm/relationships/save', command({ personId, firmId: first.firmId, status: 'current', startDate: null, endDate: null, evidence: first.evidence }));
  expect(relation.status).toBe(200);
  // Correcting the assertion is not permission to identify another human by the same label.
  const correction = await post('/crm/endpoints/correct', command({ personId, firmId: null, kind: 'linkedin', value: first.profile, shared: false, status: 'current', startDate: null, endDate: null, evidence: first.evidence, claimId: first.claimId, expectedRevision: 1 }));
  expect(correction.status).toBe(200);
  expect((await post('/crm/linkedin/routes/assess', { claimId: first.claimId })).body).toMatchObject({ state: 'held', reason: 'profile_identity_unsupported', route: null });
});

it('holds unsupported or guessed profile URLs, wrong targeting, missing fit and duplicate firms', async () => {
  const route = await supportedRoute();
  const guessed = 'https://www.linkedin.com/in/guessed-not-observed';
  await post('/crm/endpoints/correct', command({ personId: route.personId, firmId: null, kind: 'linkedin', value: guessed, shared: false, status: 'current', startDate: null, endDate: null, evidence: route.evidence, claimId: route.claimId, expectedRevision: 1 }));
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason: 'profile_identity_unsupported' });
  for (const profile of ['http://www.linkedin.com/in/someone', 'https://linkedin.com/company/someone', 'https://linkedin.com.evil.test/in/someone', 'https://user@linkedin.com/in/someone', 'https://linkedin.com/in/someone?guess=1', 'https://linkedin.com/in/someone/other']) {
    expect((await post('/crm/endpoints/claim', command({ personId: route.personId, firmId: null, kind: 'linkedin', value: profile, shared: false, status: 'current', startDate: null, endDate: null, evidence: route.evidence }))).status).toBe(409);
  }
  const noFit = await supportedRoute({ excerpt: (name, firm, profile) => `${name} is the owner of ${firm}. ${name}'s LinkedIn profile is ${profile}.\n${firm} offers website design in Providence, Rhode Island.` });
  expect((await post('/crm/linkedin/routes/assess', { claimId: noFit.claimId })).body).toMatchObject({ state: 'held', reason: 'firm_fit_unsupported' });
  const wrongArea = await supportedRoute();
  await fixture.database.session.query("UPDATE firms SET region_code='CA',locality='Los Angeles' WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, wrongArea.firmId]);
  expect((await post('/crm/linkedin/routes/assess', { claimId: wrongArea.claimId })).body).toMatchObject({ state: 'held', reason: 'target_geography_unsupported' });
  const duplicateFirm = await supportedRoute();
  await seedFirm(fixture, { name: duplicateFirm.firmName, locality: 'Providence', regionCode: 'RI', assignedUserId: fixture.alpha.salesperson.userId });
  expect((await post('/crm/linkedin/routes/assess', { claimId: duplicateFirm.claimId })).body).toMatchObject({ state: 'held', reason: 'firm_identity_ambiguous' });
});

it('corrects a profile with positive caller readback while preserving original context and past identity decisions', async () => {
  const route = await supportedRoute();
  await post('/crm/relationships/context/save', command({ personId: route.personId, relationshipId: route.relationshipId, relationshipRevision: 1, evidence: route.evidence }));
  const profile = `https://www.linkedin.com/in/corrected-${randomUUID()}`;
  const added = await post('/crm/people/source/add', command({ personId: route.personId, sourceKey: randomUUID(), excerpt: `Taylor Park's LinkedIn profile is ${profile}.`, occurredAt: '2026-10-13T14:00:00.000Z' }));
  const sourceId = (added.body as { result: { sourceId: string } }).result.sourceId;
  const source = ((await post('/crm/people/read', { personId: route.personId })).body as { sources: { sourceId: string; revision: number; contentHash: string }[] }).sources.find(row => row.sourceId === sourceId)!;
  const evidence = { sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
  const body = command({ personId: route.personId, firmId: null, kind: 'linkedin', value: profile, shared: false, status: 'current', startDate: null, endDate: null, evidence, claimId: route.claimId, expectedRevision: 1 });
  const corrected = await post('/crm/endpoints/correct', body);
  expect(corrected.status).toBe(200);
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'eligible', route: { profile, claimRevision: 2, evidence, relationshipEvidence: route.evidence, personId: route.personId } });
  expect((await post('/crm/relationships/context/read', { personId: route.personId })).body).toMatchObject({ contexts: [{ sourceId: route.evidence.sourceId, firmId: route.firmId, relationshipRevision: 1, review: 'current' }] });
  expect((await fixture.db.query<{ endpoint_id: string }>('SELECT endpoint_id FROM crm_endpoint_claim_revisions WHERE workspace_id=$1 AND claim_id=$2 AND revision=1', [fixture.alpha.workspaceId, route.claimId])).rows[0]?.endpoint_id).toBe(route.endpointId);
  expect((await post('/crm/endpoints/correct', { ...body, commandId: randomUUID() })).status).toBe(409);
});

it('deletion clears the profile, invalidates eligibility, refuses ordinary reimport and retains body-free stop facts', async () => {
  const route = await supportedRoute();
  await post('/crm/linkedin/routes/refuse', command({ claimId: route.claimId, expectedRevision: 1, firmId: route.firmId, relationshipId: route.relationshipId, expectedRelationshipRevision: 1, scope: 'person' }));
  expect((await post('/crm/people/source/delete', command({ personId: route.personId, sourceId: route.evidence.sourceId, expectedRevision: 1 }))).status).toBe(200);
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason: 'evidence_unavailable', route: null });
  expect((await post('/crm/endpoints/list', { personId: route.personId })).body).toMatchObject({ claims: [] });
  expect((await post('/crm/people/source/add', command({ personId: route.personId, sourceKey: route.sourceKey, excerpt: route.text, occurredAt: '2026-10-13T14:00:00.000Z' }))).status).toBe(409);
  expect((await fixture.db.query<{ value: string | null }>('SELECT value FROM crm_identity_endpoints WHERE workspace_id=$1 AND id=$2', [fixture.alpha.workspaceId, route.endpointId])).rows[0]?.value).toBeNull();
  const stops = (await fixture.db.query<Record<string, unknown>>('SELECT * FROM linkedin_route_refusals WHERE workspace_id=$1 AND person_id=$2', [fixture.alpha.workspaceId, route.personId])).rows;
  expect(stops).toHaveLength(1);
  expect(JSON.stringify(stops)).not.toContain(route.profile);
  expect(JSON.stringify(stops)).not.toContain('Taylor Park');
});

async function waitForBlock(observer: SessionQueryable, pid: number | undefined) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await observer.query<{ blocked: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0]?.blocked === true) return;
    await delay(5);
  }
  throw new Error('Public request did not reach the real PostgreSQL barrier');
}
const identityContext = (db: SessionQueryable) => repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), db);

it('rechecks relationship correction and source deletion after genuine PostgreSQL waits', async () => {
  for (const mutation of ['relationship', 'source']) {
    const route = await supportedRoute();
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    const changed = mutation === 'relationship'
      ? await correctRelationship(identityContext(holder), { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, personId: route.personId, relationshipId: route.relationshipId, expectedRevision: 1, firmId: route.firmId, status: 'historical', startDate: null, endDate: null, evidence: route.evidence })
      : await changeSelectedSource(identityContext(holder), { personId: route.personId, sourceId: route.evidence.sourceId, expectedRevision: 1 }, 'delete');
    expect(changed.ok).toBe(true);
    const pending = post('/crm/linkedin/routes/assess', { claimId: route.claimId });
    try { await waitForBlock(observer, pid); } finally { await holder.query('COMMIT'); }
    const read = await pending;
    if (mutation === 'source') expect(read.status).toBe(404);
    else expect(read.body).toMatchObject({ state: 'held', reason: 'identity_changed', route: null });
  }
});

async function privateEvidenceAudit(sourceId: string) {
  return (await fixture.db.query<{ actor_user_id: string; subject_kind: string; detail: Record<string, unknown> }>('SELECT actor_user_id,subject_kind,detail FROM audit_events WHERE workspace_id=$1 AND action=$2 AND subject_id=$3', [fixture.alpha.workspaceId, 'crm.linkedin_private_evidence_read', sourceId])).rows;
}

async function heldRoute(variant: string) {
  const route = await supportedRoute({ excerpt: (name, firm, profile) => {
    const profileName = variant === 'profile' ? 'Jordan Fields' : name;
    const roleName = variant === 'role' ? 'Jordan Fields' : name;
    return `${roleName} is the owner of ${firm}. ${profileName}'s LinkedIn profile is ${profile}.\n${firm} ${variant === 'fit' ? 'offers website design in Providence, Rhode Island' : 'is an independent residential property management firm serving Providence, Rhode Island'}.`;
  } });
  if (variant === 'geography') await fixture.database.session.query("UPDATE firms SET region_code='CA',locality='Los Angeles' WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, route.firmId]);
  if (variant === 'stopped') expect((await post('/crm/linkedin/routes/refuse', command({ claimId: route.claimId, expectedRevision: 1, firmId: route.firmId, relationshipId: route.relationshipId, expectedRelationshipRevision: 1, scope: 'person' }))).status).toBe(200);
  return route;
}

it.each([
  ['profile', 'profile_identity_unsupported'], ['role', 'role_or_firm_unsupported'],
  ['fit', 'firm_fit_unsupported'], ['geography', 'target_geography_unsupported'],
  ['stopped', 'person_or_firm_stopped'],
])('audits nonowned admin private evidence before the %s hold, once per original source', async (variant, reason) => {
  const route = await heldRoute(variant);
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason });
  expect(await privateEvidenceAudit(route.evidence.sourceId)).toEqual([]);
  const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId }, adminToken)).body).toMatchObject({ state: 'held', reason });
  const audit = await privateEvidenceAudit(route.evidence.sourceId);
  expect(audit).toEqual([{ actor_user_id: fixture.alpha.admin.userId, subject_kind: 'selected_source', detail: { claimId: route.claimId, claimRevision: 1, relationshipId: route.relationshipId, relationshipRevision: 1 } }]);
  for (const content of [route.profile, 'Taylor Park', route.firmName, route.text]) expect(JSON.stringify(audit)).not.toContain(content);
});

it.each(['eligible', 'fit', 'stopped'])('rechecks current membership after an endpoint lock wait before the %s outcome or private audit', async (variant) => {
  const route = await heldRoute(variant);
  await fixture.database.session.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT (workspace_id,user_id) DO NOTHING", [fixture.alpha.workspaceId, fixture.beta.admin.userId]);
  const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  const holder = await fixture.database.appRuntimeSession();
  const observer = await fixture.database.appRuntimeSession();
  const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [fixture.alpha.workspaceId, route.endpointId]);
  const pending = post('/crm/linkedin/routes/assess', { claimId: route.claimId }, adminToken);
  try {
    await waitForBlock(observer, pid);
    // Controlled fixture mutation, not the serialized full-departure command.
    await observer.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.admin.userId]);
  } finally { await holder.query('COMMIT'); }
  let read;
  try { read = await pending; } finally {
    await observer.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.admin.userId]);
  }
  expect(read.status).toBe(404);
  expect(await privateEvidenceAudit(route.evidence.sourceId)).toEqual([]);
  // The same nonowned evidence is accessible and audited once authority is restored.
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId }, adminToken)).status).toBe(200);
  expect(await privateEvidenceAudit(route.evidence.sourceId)).toHaveLength(1);
});

it.each(['profile_denied', 'profile_denied_normalized', 'profile_uncertain', 'role_denied', 'role_uncertain', 'firm_denied', 'firm_uncertain'])('does not salvage positive support from contradictory selected evidence: %s', async (variant) => {
  const route = await supportedRoute({ excerpt: (name, firm, profile) => {
    const conflict = variant === 'profile_denied' ? `${name}'s LinkedIn profile is not ${profile}.`
      : variant === 'profile_denied_normalized' ? `${name}'s LinkedIn profile is not ${profile.replace('www.', '')}/.`
      : variant === 'profile_uncertain' ? `${name}'s LinkedIn profile might be ${profile}.`
      : variant === 'role_denied' ? `${name} is not the owner of ${firm}.`
      : variant === 'role_uncertain' ? `${name} might be the owner of ${firm}.`
      : variant === 'firm_denied' ? `${firm} is not an independent residential property management firm serving Providence, Rhode Island.`
      : `${firm} might be an independent residential property management firm serving Providence, Rhode Island.`;
    return `${name} is the owner of ${firm}. ${name}'s LinkedIn profile is ${profile}.\n${firm} is an independent residential property management firm serving Providence, Rhode Island.\n${conflict}`;
  } });
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', route: null, reason: variant.startsWith('profile') ? 'profile_identity_unsupported' : variant.startsWith('role') ? 'role_or_firm_unsupported' : 'firm_fit_unsupported' });
});

it('does not treat unrelated named uncertainty as a contradiction of supported evidence', async () => {
  const route = await supportedRoute({ excerpt: (name, firm, profile) => `${name} is the owner of ${firm}. ${name}'s LinkedIn profile is ${profile}.\n${firm} is an independent residential property management firm serving Providence, Rhode Island.\nJordan Fields is not the owner of ${firm}. Jordan Fields's LinkedIn profile might be https://www.linkedin.com/in/someone-else.\nOther Management is not an independent residential property management firm.` });
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'eligible' });
});

it('does not audit an admin reading their own selected evidence', async () => {
  const ownerToken = token;
  const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  let route;
  try { token = adminToken; route = await heldRoute('fit'); } finally { token = ownerToken; }
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId }, adminToken)).body).toMatchObject({ state: 'held', reason: 'firm_fit_unsupported' });
  expect(await privateEvidenceAudit(route.evidence.sourceId)).toEqual([]);
});

it('rechecks current membership after an endpoint lock wait', async () => {
  const route = await supportedRoute();
  const holder = await fixture.database.appRuntimeSession();
  const observer = await fixture.database.appRuntimeSession();
  const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [fixture.alpha.workspaceId, route.endpointId]);
  const pending = post('/crm/linkedin/routes/assess', { claimId: route.claimId });
  try {
    await waitForBlock(observer, pid);
    await observer.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId]);
  } finally { await holder.query('COMMIT'); }
  const read = await pending;
  await observer.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId]);
  expect(read.status).toBe(404);
});

it('rechecks a real endpoint correction before publishing the profile', async () => {
  const route = await supportedRoute();
  const holder = await fixture.database.appRuntimeSession();
  const observer = await fixture.database.appRuntimeSession();
  const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  await holder.query('BEGIN');
  expect((await correctEndpoint(identityContext(holder), { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, personId: route.personId, firmId: null, kind: 'linkedin', value: route.profile, shared: false, status: 'unknown', startDate: null, endDate: null, evidence: route.evidence, claimId: route.claimId, expectedRevision: 1 })).ok).toBe(true);
  const pending = post('/crm/linkedin/routes/assess', { claimId: route.claimId });
  try { await waitForBlock(observer, pid); } finally { await holder.query('COMMIT'); }
  expect((await pending).body).toMatchObject({ state: 'held', reason: 'identity_changed', route: null });
});

it('rechecks original firm assignment after a supported reassignment wait', async () => {
  const route = await supportedRoute();
  const holder = await fixture.database.appRuntimeSession();
  const observer = await fixture.database.appRuntimeSession();
  const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  await holder.query('BEGIN');
  expect((await reassignFirm(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), holder), { firmId: route.firmId, toUserId: fixture.alpha.admin.userId })).ok).toBe(true);
  const pending = post('/crm/linkedin/routes/assess', { claimId: route.claimId });
  try { await waitForBlock(observer, pid); } finally { await holder.query('COMMIT'); }
  expect((await pending).status).toBe(404);
});

it('holds existing firm and supported Person-handle suppressions without transferring email technical gates', async () => {
  for (const scope of ['firm', 'handle']) {
    const route = await supportedRoute();
    const address = `${randomUUID()}@business.example.test`;
    if (scope === 'handle') expect((await post('/crm/endpoints/claim', command({ personId: route.personId, firmId: null, kind: 'email', value: address, shared: false, status: 'current', startDate: null, endDate: null, evidence: route.evidence }))).status).toBe(200);
    expect((await post('/suppressions/record', command({ scope, ...(scope === 'firm' ? { firmId: route.firmId } : { value: address }), source: 'prospect_opt_out', channel: 'all' }))).status).toBe(200);
    expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason: 'person_or_firm_stopped', route: null });
  }
});

it('does not identify a human from a shared firm profile or bypass another original source context', async () => {
  const route = await supportedRoute();
  const firmSource = await post('/crm/firm-sources/add', command({ firmId: route.firmId, sourceKey: randomUUID(), excerpt: 'Shared office profile, not a human identity', occurredAt: '2026-10-13T14:00:00.000Z' }));
  const sourceId = (firmSource.body as { result: { sourceId: string } }).result.sourceId;
  const source = ((await post('/crm/firm-sources/read', { firmId: route.firmId })).body as { sources: { sourceId: string; revision: number; contentHash: string }[] }).sources.find(row => row.sourceId === sourceId)!;
  const shared = await post('/crm/endpoints/claim', command({ personId: null, firmId: route.firmId, kind: 'linkedin', value: `https://www.linkedin.com/in/shared-${randomUUID()}`, shared: true, status: 'current', startDate: null, endDate: null, evidence: { sourceId, sourceRevision: source.revision, contentHash: source.contentHash } }));
  expect((await post('/crm/linkedin/routes/assess', { claimId: (shared.body as { result: { claimId: string } }).result.claimId })).body).toMatchObject({ state: 'held', reason: 'shared_profile', route: null });
  await post('/crm/relationships/context/save', command({ personId: route.personId, relationshipId: route.relationshipId, relationshipRevision: 1, evidence: route.evidence }));
  const otherFirm = await seedFirm(fixture, { name: 'Indivisible original context', assignedUserId: fixture.alpha.salesperson.userId });
  const relation = await post('/crm/relationships/save', command({ personId: route.personId, firmId: otherFirm, status: 'historical', startDate: null, endDate: null, evidence: route.evidence }));
  const relationshipId = (relation.body as { result: { relationshipId: string } }).result.relationshipId;
  await post('/crm/relationships/context/save', command({ personId: route.personId, relationshipId, relationshipRevision: 1, evidence: route.evidence }));
  await reassignFirm(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), fixture.db), { firmId: otherFirm, toUserId: fixture.alpha.admin.userId });
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).status).toBe(404);
});

it.each(['builds websites for Other Independent Residential Property Management', 'provides website design to independent residential property managers', 'competes with an independent residential property management firm'])('does not borrow residential fit: %s', async (description) => {
  const route = await supportedRoute({ excerpt: (name, firm, profile) => `${name} is the owner of ${firm}. ${name}'s LinkedIn profile is ${profile}.\n${firm} ${description} serving Providence, Rhode Island.` });
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason: 'firm_fit_unsupported' });
});

it('refuses client proof flags, stale source versions and future profile assertions', async () => {
  const route = await supportedRoute();
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId, verifiedFit: true })).status).toBe(400);
  expect((await post('/crm/endpoints/correct', command({ personId: route.personId, firmId: null, kind: 'linkedin', value: route.profile, shared: false, status: 'current', startDate: null, endDate: null, evidence: { ...route.evidence, sourceRevision: 2 }, claimId: route.claimId, expectedRevision: 1 }))).status).toBe(409);
  expect((await post('/crm/endpoints/correct', command({ personId: route.personId, firmId: null, kind: 'linkedin', value: route.profile, shared: false, status: 'current', startDate: '2999-01-01', endDate: null, evidence: route.evidence, claimId: route.claimId, expectedRevision: 1 }))).status).toBe(200);
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason: 'profile_not_current' });
});

it('refuses stale human refusal snapshots and replays one accepted stop without duplicating it', async () => {
  const route = await supportedRoute();
  const body = command({ claimId: route.claimId, expectedRevision: 1, firmId: route.firmId, relationshipId: route.relationshipId, expectedRelationshipRevision: 1, scope: 'person' });
  const accepted = await post('/crm/linkedin/routes/refuse', body);
  expect(accepted.status).toBe(200);
  expect((await post('/crm/linkedin/routes/refuse', body)).body).toEqual({ ...(accepted.body as object), replayed: true });
  expect((await post('/crm/linkedin/routes/refuse', { ...body, commandId: randomUUID(), expectedRelationshipRevision: 2 })).status).toBe(409);
  const otherFirm = await seedFirm(fixture, { name: 'No declared refusal provenance', assignedUserId: fixture.alpha.salesperson.userId });
  expect((await post('/crm/linkedin/routes/refuse', { ...body, commandId: randomUUID(), firmId: otherFirm })).status).toBe(409);
  const runtime = await fixture.database.appRuntimeSession();
  expect((await runtime.query('SELECT id FROM linkedin_route_refusals WHERE workspace_id=$1 AND person_id=$2', [fixture.alpha.workspaceId, route.personId])).rows).toHaveLength(1);
  const audit = (await runtime.query<{ detail: Record<string, unknown> }>('SELECT detail FROM audit_events WHERE workspace_id=$1 AND action=$2 AND subject_id=$3', [fixture.alpha.workspaceId, 'crm.linkedin_refusal_recorded', route.personId])).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0]?.detail).toMatchObject({ scope: 'person', claimRevision: 1, relationshipRevision: 1, firmId: route.firmId });
  expect(JSON.stringify(audit)).not.toContain(route.profile);
  expect(JSON.stringify(audit)).not.toContain('Taylor Park');
  await expect(runtime.query('DELETE FROM linkedin_route_refusals WHERE workspace_id=$1 AND person_id=$2', [fixture.alpha.workspaceId, route.personId])).rejects.toThrow(/permission denied/u);
});

it('preserves the original person stop through fresh evidence, profile correction and assignment changes', async () => {
  const route = await supportedRoute();
  expect((await post('/crm/linkedin/routes/refuse', command({ claimId: route.claimId, expectedRevision: 1, firmId: route.firmId, relationshipId: route.relationshipId, expectedRelationshipRevision: 1, scope: 'person' }))).status).toBe(200);
  const profile = `https://www.linkedin.com/in/revised-${randomUUID()}`;
  const added = await post('/crm/people/source/add', command({ personId: route.personId, sourceKey: randomUUID(), excerpt: `Taylor Park is the owner of ${route.firmName}. Taylor Park's LinkedIn profile is ${profile}.\n${route.firmName} is an independent residential property management firm serving Providence, Rhode Island.`, occurredAt: '2026-10-13T14:00:00.000Z' }));
  const sourceId = (added.body as { result: { sourceId: string } }).result.sourceId;
  const source = ((await post('/crm/people/read', { personId: route.personId })).body as { sources: { sourceId: string; revision: number; contentHash: string }[] }).sources.find(row => row.sourceId === sourceId)!;
  const evidence = { sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
  expect((await post('/crm/endpoints/correct', command({ personId: route.personId, firmId: null, kind: 'linkedin', value: profile, shared: false, status: 'current', startDate: null, endDate: null, evidence, claimId: route.claimId, expectedRevision: 1 }))).status).toBe(200);
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason: 'person_or_firm_stopped' });
  expect((await post('/crm/relationships/correct', command({ personId: route.personId, relationshipId: route.relationshipId, expectedRevision: 1, firmId: route.firmId, status: 'current', startDate: null, endDate: null, evidence }))).status).toBe(200);
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason: 'relationship_needs_review' });
  const admin = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), fixture.db);
  await reassignFirm(admin, { firmId: route.firmId, toUserId: fixture.alpha.admin.userId });
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).status).toBe(404);
  await reassignFirm(admin, { firmId: route.firmId, toUserId: fixture.alpha.salesperson.userId });
  expect((await post('/crm/linkedin/routes/assess', { claimId: route.claimId })).body).toMatchObject({ state: 'held', reason: 'relationship_needs_review' });
  expect((await fixture.db.query('SELECT claim_revision,relationship_revision FROM linkedin_route_refusals WHERE workspace_id=$1 AND person_id=$2', [fixture.alpha.workspaceId, route.personId])).rows).toEqual([{ claim_revision: 1, relationship_revision: 1 }]);
});

it('refuses a human stop when a source deletion commits while the command is waiting', async () => {
  const route = await supportedRoute();
  const holder = await fixture.database.appRuntimeSession();
  const observer = await fixture.database.appRuntimeSession();
  const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  await holder.query('BEGIN');
  expect((await changeSelectedSource(identityContext(holder), { personId: route.personId, sourceId: route.evidence.sourceId, expectedRevision: 1 }, 'delete')).ok).toBe(true);
  const pending = post('/crm/linkedin/routes/refuse', command({ claimId: route.claimId, expectedRevision: 1, firmId: route.firmId, relationshipId: route.relationshipId, expectedRelationshipRevision: 1, scope: 'firm' }));
  try { await waitForBlock(observer, pid); } finally { await holder.query('COMMIT'); }
  expect((await pending).status).toBe(409);
  expect((await fixture.db.query('SELECT id FROM linkedin_route_refusals WHERE workspace_id=$1 AND person_id=$2', [fixture.alpha.workspaceId, route.personId])).rows).toHaveLength(0);
});

it('resolves selected evidence through authenticated commands and positive profile Route readback without granting send permission', async () => {
  const firmId = await seedFirm(fixture, { name: 'Harbor Management', locality: 'Providence', regionCode: 'RI', assignedUserId: fixture.alpha.salesperson.userId });
  const created = await post('/crm/people/create', command({ fullName: 'Taylor Park' }));
  const personId = (created.body as { result: { personId: string } }).result.personId;
  const profile = 'https://www.linkedin.com/in/taylor-park-626';
  await post('/crm/people/source/add', command({ personId, sourceKey: randomUUID(), excerpt: `Taylor Park is the owner of Harbor Management. Taylor Park's LinkedIn profile is ${profile}.\nHarbor Management is an independent residential property management firm serving Providence, Rhode Island.`, occurredAt: '2026-10-13T14:00:00.000Z' }));
  const page = await post('/crm/people/read', { personId });
  const source = (page.body as { sources: { sourceId: string; revision: number; contentHash: string }[] }).sources[0]!;
  const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
  const relationship = await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }));
  const relationshipId = (relationship.body as { result: { relationshipId: string } }).result.relationshipId;
  const claimed = await post('/crm/endpoints/claim', command({ personId, firmId: null, kind: 'linkedin', value: profile, shared: false, status: 'current', startDate: null, endDate: null, evidence }));
  expect(claimed.status).toBe(200);
  const { claimId, endpointId } = (claimed.body as { result: { claimId: string; endpointId: string } }).result;
  expect((await post('/crm/endpoints/list', { personId })).body).toMatchObject({ claims: [{ claimId, endpointId, kind: 'linkedin', value: profile, evidence }] });
  const assessed = await post('/crm/linkedin/routes/assess', { claimId });
  expect(assessed.status).toBe(200);
  expect(assessed.body).toMatchObject({ state: 'eligible', reason: 'supported_fit', route: { routeId: endpointId, claimId, profile, personId, firmId, relationshipId, relationshipRevision: 1, evidence }, sendingPermission: false, connectionState: 'unknown', maintenanceNeed: 'unknown', buyingIntent: 'unknown' });
});
