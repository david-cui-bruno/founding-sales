import { createHash, randomUUID } from 'node:crypto';
import type { AccountRecord } from '../../../../../src/shared/contracts/accountRecordContract';
import type { AccountRoute } from '../../../../../src/shared/contracts/accountContract';
import { enrollmentSchema, type CampaignVersion, type Enrollment, type StepEvidence } from '../../../../../src/shared/contracts/campaignContract';
import { deriveTerritoryCampaignVersion, DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, territoryCallPolicyId, territoryCallPolicySchema,
  territoryEnrollmentCommandId, territoryEnrollmentId, territoryExecutionContextId, territoryHeldSteps, type TerritoryCallPolicy } from '../../../../../src/shared/contracts/territoryCallPolicyContract';
import { TERRITORY_RULES_REVISION } from '../../../../../src/shared/contracts/territoryClearanceContract';
import type { StatePosture } from '../../../../../src/shared/contracts/v1Contract';
import type { DynamoStore } from '../../src/dynamoStore';
import { fingerprint } from '../../src/dynamoStore';
import { RemoteGoogleAuthorization } from '../../src/remoteGoogleAuthorization';
import { createSourceCoordinator, type SourceTickReport } from '../../src/sourceCoordinator';
import { dayKey, dayRecordSchema, type DayRecord } from '../../src/v1/dayBuild';
import { accountKey } from '../../src/workerAccountRepository';
import type { v1Fixture } from './v1Fixture';
import { campaignEnrollmentKey, campaignVersionKey, territoryEnrollmentKey, territoryRetiredRouteKey } from '../../src/workerCampaignRepository';
import { territoryCallPolicyKey, type TerritoryEnrollmentRecord } from '../../src/territoryPolicyRepository';
import { mailSuppressionKey } from '../../src/threadIntakeRepository';

/**
 * Today's records, exactly as the worker writes them, for the S1 scenario tests: `ACCOUNT#` firms with a Places
 * listing source (the only place a firm's address lives), the standing territory policy, the enrollment pair
 * (`TERRITORY_ENROLLMENT#` plus `CAMPAIGN_ENROLLMENT#` and its derived `CAMPAIGN_VERSION#`), old-key call
 * evidence, retired routes and mail suppression. Every address, number and domain is fictional; phone numbers
 * stay outside the 555-0100 to 555-0199 block the production launcher refuses.
 */
export const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export type FirmInput = {
  id: string; name: string; domain?: string | null;
  /** The Places `formattedAddress`, or null for a listing without one. */
  address: string | null;
  /** The listed business phone; null for a firm without a phone route. */
  phone?: string | null;
  phoneVerification?: AccountRoute['verification'];
  businessEmail?: string | null;
  /** When the firm's evidence was last admitted (research recency). */
  researchedAt: string;
};

/** One firm record shaped like the Places materialisation plus, optionally, a page research pass that found a business email. */
export function firmRecord(input: FirmInput): AccountRecord {
  const domain = input.domain === undefined ? `${input.id.replace(/[^a-z0-9]/g, '')}.example` : input.domain;
  const account = { id: input.id, name: input.name, domain, version: 1 };
  const placeId = `ChIJ${sha(input.id).slice(0, 20)}`;
  const excerpt = JSON.stringify({ id: placeId, displayName: input.name, ...(input.address === null ? {} : { formattedAddress: input.address }),
    ...(input.phone ? { nationalPhoneNumber: input.phone } : {}), ...(domain ? { websiteUri: `https://${domain}/` } : {}) });
  const placeSource = { id: `place-${placeId}`, url: PLACES_URL, fetchedAt: input.researchedAt, sha256: sha(excerpt), excerpt, permitted: true };
  const sources = [placeSource];
  const routes: AccountRoute[] = [];
  const claims: AccountRecord['claims'] = [];
  if (input.phone) routes.push({ id: `route-${fingerprint([input.id, 'listed-phone', input.phone])}`, accountId: input.id, personId: null, channel: 'phone',
    value: input.phone, purpose: 'business', evidenceIds: [placeSource.id], verification: input.phoneVerification ?? 'listed', version: 1 });
  if (input.businessEmail) {
    const pageExcerpt = `Contact us at ${input.businessEmail} for maintenance.`;
    const page = { id: `page-${sha(input.id).slice(0, 12)}`, url: `https://${domain ?? 'firm.example'}/contact`, fetchedAt: input.researchedAt, sha256: sha(pageExcerpt), excerpt: pageExcerpt, permitted: true };
    sources.push(page);
    claims.push({ kind: 'fact', key: 'business_email', value: input.businessEmail, selection: 'role_mailbox', evidenceIds: [page.id] });
    routes.push({ id: `route-business-email-${fingerprint({ accountId: input.id, email: input.businessEmail })}`, accountId: input.id, personId: null, channel: 'email',
      value: input.businessEmail, purpose: 'business', evidenceIds: [page.id], verification: 'published', version: 1 });
  }
  const version = { ...account, version: 1 + routes.length };
  return { account: version, sources, claims, routes, researchRevision: 1 + routes.length,
    history: [{ at: input.researchedAt, account, claims: [], routes: [] }, { at: input.researchedAt, account: version, claims, routes }] };
}

export async function putFirm(store: DynamoStore, input: FirmInput): Promise<AccountRecord> {
  const record = firmRecord(input);
  await store.transact([store.put(accountKey(record.account.id), record, null, { accountId: record.account.id, version: record.account.version })]);
  return record;
}

/** The standing territory policy (David's D13 v1 default), active, so the offer text and the sequence exist. */
export async function putTerritoryPolicy(store: DynamoStore, approvedAt: string): Promise<TerritoryCallPolicy> {
  const workspaceId = store.options.workspaceId;
  const policy = territoryCallPolicySchema.parse({ ...DEFAULT_TERRITORY_CALL_POLICY_DEFINITION, policyId: territoryCallPolicyId(workspaceId), workspaceId,
    pairingId: 'fictional-pairing', revision: 1, state: 'active', approvedAt, approvedRevision: 1, updatedAt: approvedAt });
  await store.transact([store.put(territoryCallPolicyKey(workspaceId), policy, null)]);
  return policy;
}

export type EnrollInput = {
  firmId: string; routeId: string; policy: TerritoryCallPolicy; startedAt: string;
  /** Index into the derived version's steps the firm currently stands on (0 is the first call). */
  stepIndex?: number;
  nextDueAt?: string | null;
  state?: Enrollment['state'];
  restingUntil?: string | null;
};
/** Enroll one firm the way `applyTerritoryPolicy` does, then move it to `stepIndex` the way an applied outcome would. */
export async function enrollFirm(store: DynamoStore, input: EnrollInput): Promise<{ record: TerritoryEnrollmentRecord; enrollment: Enrollment; version: CampaignVersion }> {
  const version = deriveTerritoryCampaignVersion(input.policy, input.firmId);
  const enrollmentId = territoryEnrollmentId(input.policy, input.firmId);
  const step = version.steps[input.stepIndex ?? 0];
  if (!step) throw new Error('fixture_step_index');
  const enrollment = enrollmentSchema.parse({ id: enrollmentId, accountId: input.firmId, selectedRouteId: input.routeId, selectedRouteVersion: 1, personId: null,
    campaignVersionId: version.id, currentStepId: step.id, version: 1 + (input.stepIndex ?? 0), state: input.state ?? 'active',
    executionContextId: territoryExecutionContextId(input.policy, input.firmId), contextRevision: 1, startedAt: input.startedAt,
    nextDueAt: input.nextDueAt === undefined ? new Date(Date.parse(input.startedAt) + step.delayHours * 3600000).toISOString() : input.nextDueAt,
    ...(input.restingUntil === undefined ? {} : { restingUntil: input.restingUntil }) });
  const record: TerritoryEnrollmentRecord = { policyId: input.policy.policyId, revision: input.policy.revision, accountId: input.firmId, routeId: input.routeId,
    commandId: territoryEnrollmentCommandId(input.policy, input.firmId), versionId: version.id, enrollmentId, sequence: 1,
    heldSteps: territoryHeldSteps(version, input.policy.sequence), grantedAt: input.startedAt };
  const existingVersion = await store.get<unknown>(campaignVersionKey(version.id));
  await store.transact([
    ...(existingVersion ? [] : [store.put(campaignVersionKey(version.id), version, null)]),
    store.put(campaignEnrollmentKey(enrollmentId), enrollment, null),
    store.put(territoryEnrollmentKey(input.firmId), record, null)]);
  return { record, enrollment, version };
}

/** One old-key call outcome: the `CAMPAIGN_EVIDENCE#` row an applied `complete-manual` leaves behind. */
export async function putCallEvidence(store: DynamoStore, input: { enrollment: Enrollment; version: CampaignVersion; routeId: string; outcome: string; observedAt: string }): Promise<StepEvidence> {
  const commandId = randomUUID();
  const evidence: StepEvidence = { enrollmentId: input.enrollment.id, accountId: input.enrollment.accountId, campaignVersionId: input.version.id,
    stepId: input.version.steps[0]!.id, routeId: input.routeId, routeVersion: 1, outcome: input.outcome, observedAt: input.observedAt, observation: 'unknown',
    source: 'human', executionContextId: input.enrollment.executionContextId, contextRevision: 1,
    state: ['cancelled', 'not_called'].includes(input.outcome) ? 'cancelled' : input.outcome === 'unknown' ? 'unknown' : 'human_reported_sent', actionId: `action-${commandId}`, channel: 'call' };
  await store.transact([store.put(`CAMPAIGN_EVIDENCE#${encodeURIComponent(input.enrollment.id)}#${commandId}`, evidence, null)]);
  return evidence;
}

export async function putRetiredRoute(store: DynamoStore, input: { firmId: string; routeId: string; retiredAt: string }): Promise<void> {
  await store.transact([store.put(territoryRetiredRouteKey(input.firmId, input.routeId), { accountId: input.firmId, routeId: input.routeId, routeVersion: 1,
    retiredAt: input.retiredAt, reason: 'wrong_number', commandId: randomUUID() }, null)]);
}

export async function putMailSuppression(store: DynamoStore, firmId: string, observedAt: string): Promise<void> {
  await store.transact([store.put(mailSuppressionKey(firmId), { accountId: firmId, observedAt, evidence: [] }, null)]);
}

/** The listed phone route id `firmRecord` derives, so a test can name it without reading the record back. */
export const listedRouteId = (firmId: string, phone: string): string => `route-${fingerprint([firmId, 'listed-phone', phone])}`;

/** A fictional Rhode Island firm `n`: Providence address, a listed phone outside the refused 555-01XX block. */
export function riFirm(n: number, extra: Partial<FirmInput> = {}): FirmInput {
  return { id: `account-ri-${n}`, name: `Rhode Island Firm ${n}`, address: `${n} Hope St, Providence, RI 02906, USA`, phone: `+1401555${String(200 + n).padStart(4, '0')}`,
    researchedAt: `2026-09-${String(10 + (n % 7)).padStart(2, '0')}T12:00:00.000Z`, ...extra };
}

/** The existing scheduled tick on the fixture's store: no providers, every HTTP boundary refused. Returns the report and the console lines the tick logged. */
export function tickOf(f: ReturnType<typeof v1Fixture>): () => Promise<{ report: SourceTickReport; lines: string[] }> {
  const fetch: typeof globalThis.fetch = async () => { throw new Error('unconfigured fictional HTTP'); };
  const authorization = new RemoteGoogleAuthorization({ auth: f.auth, fetch });
  const source = createSourceCoordinator({ auth: f.auth, authorization, fetch });
  return async () => {
    const log = console.log; const lines: string[] = []; console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try { return { report: await source.tick(new AbortController().signal), lines }; } finally { console.log = log; }
  };
}

/** Record David's posture for one state through the real command route. */
export async function setPosture(f: ReturnType<typeof v1Fixture>, bearer: string, state: string, posture: StatePosture): Promise<void> {
  const response = await f.request('POST', '/v1/commands', { authorization: bearer, body: { commandId: randomUUID(), kind: 'set_state_posture', state, posture,
    registration: { status: 'exempt', citation: 'checked' }, dncList: { status: 'not_required', citation: 'checked' }, referenceTextRevision: TERRITORY_RULES_REVISION } });
  if (response.statusCode !== 200) throw new Error(`posture failed in fixture: ${response.statusCode}`);
}

/** An earlier day's list, written the way the build writes it, so "never in any earlier DAY#" has something to read. */
export async function putDay(store: DynamoStore, input: { date: string; builtAt: string; newFirmIds: string[] }): Promise<DayRecord> {
  const record = dayRecordSchema.parse({ version: 1, date: input.date, timeZone: 'America/New_York', builtAt: input.builtAt,
    lanes: { replies: [], callbacks: [], due: [], new: input.newFirmIds.map(firmId => ({ firmId, reason: 'new_firm' })) }, poolSize: input.newFirmIds.length, excluded: {} });
  await store.transact([store.put(dayKey(input.date), record, null)]);
  return record;
}

export const readDay = (f: ReturnType<typeof v1Fixture>, date: string): DayRecord | null => {
  const raw = f.db.inspect(dayKey(date));
  return raw === undefined ? null : dayRecordSchema.parse(raw);
};
