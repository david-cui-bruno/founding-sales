import { randomBytes } from 'node:crypto';
import type { CallAnalysisResponse, CallProposalEdits, CallTranscriptUtterance } from '@fss/contracts';
import { completeCallAnalysis, createAnalysisVersion, readCallAnalysis, readPolicyContext } from '../../../calls/analysis.ts';
import { applyCallProposals, type ApplyCallProposalsOutcome } from '../../../calls/proposalApply.ts';
import { consumeCallSession, createCallSession, recordCallRecording, recordCallStatus } from '../../../calls/sessions.ts';
import { withTransaction, type SessionQueryable } from '../../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../../db/workspaceScope.ts';
import { updateSetting } from '../../../settings/store.ts';
import { recordingSuppressionJournal } from '../../../suppression/journal.ts';
import { firstStageId, seedCrm, type SeededCrm } from '../../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../../db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '../../db/support/policyFixtures.ts';

/**
 * The world lane B's apply tests share (slice 3a): a database, two workspaces, and
 * calls placed, answered, recorded, transcribed and analysed through the real commands
 * (`createCallSession`, `consumeCallSession`, `recordCallStatus`, `recordCallRecording`,
 * then lane A's production writers `createAnalysisVersion` and `completeCallAnalysis`).
 *
 * Each call can be placed to a firm of its own (`newFirm`), so the firm-wide facts a test
 * asserts — the open opportunity, a park, the stage evidence — are that test's alone.
 */

export interface ApplyWorld {
  readonly database: TestDatabase;
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
  readonly policy: SeededPolicy;
  connection(): Promise<SessionQueryable>;
  system(db?: SessionQueryable): RepositoryContext;
  salesperson(db?: SessionQueryable): RepositoryContext;
  admin(db?: SessionQueryable): RepositoryContext;
  newFirm(options?: { readonly opportunity?: 'open' | 'closed' | 'none'; readonly timeZone?: string | null }): Promise<TestFirm>;
  placeCall(firm: TestFirm, utterances: readonly CallTranscriptUtterance[], options?: PlaceOptions): Promise<PlacedCall>;
  analyse(call: PlacedCall, rawAnswer: string, db?: SessionQueryable): Promise<Analysed>;
  read(sessionId: string): Promise<CallAnalysisResponse>;
  setTranscription(enabled: boolean): Promise<void>;
  drop(): Promise<void>;
}

export interface TestFirm {
  readonly firmId: string;
  readonly contactId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly e164: string;
}

export interface PlaceOptions {
  /** The status deliveries after the call is placed, in order. Default: answered, then completed after 125 s. */
  readonly statuses?: readonly { readonly status: string; readonly seconds?: number }[];
  /** A recording delivery of this many seconds, after the statuses. Default 125; null for none. */
  readonly recordingSeconds?: number | null;
  /** Store the transcript (default true). */
  readonly transcript?: boolean;
}

export interface PlacedCall {
  readonly sessionId: string;
  readonly callSid: string;
  readonly firm: TestFirm;
  readonly utterances: readonly CallTranscriptUtterance[];
}

export interface Analysed extends PlacedCall {
  readonly analysisId: string;
  readonly version: number;
  readonly transcriptSha256: string;
  readonly proposalHash: string;
  readonly keys: readonly string[];
}

let firmCounter = 0;

export async function createApplyWorld(): Promise<ApplyWorld> {
  const database = await createTestDatabase();
  const session = database.session;
  const seeded = await seedTwoWorkspaces(session);
  const crm = await seedCrm(session, seeded);
  const policy = await seedPolicy(session, seeded, crm);
  const workspaceId = seeded.alpha.workspaceId;

  const scoped = (actor: Parameters<typeof workspaceScope>[1], db: SessionQueryable): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId, actor), db);
  const system = (db: SessionQueryable = session): RepositoryContext => scoped({ kind: 'system', component: 'worker' }, db);
  const salesperson = (db: SessionQueryable = session): RepositoryContext =>
    scoped({ kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }, db);
  const admin = (db: SessionQueryable = session): RepositoryContext =>
    scoped({ kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }, db);

  const setting = async (settingKey: 'telephony_budget' | 'call_transcription', value: unknown): Promise<void> => {
    const saved = await withTransaction(session, async () => await updateSetting(admin(), { settingKey, value } as never));
    if (!saved.ok) throw new Error(saved.reason);
  };
  await setting('telephony_budget', { dailyCeilingCents: 10_000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 });
  // A worker that can transcribe is up (its heartbeat says so), so the callbacks queue the
  // transcription and admit the pending hold (`admitToAnalysisPath`, review S3T finding 2).
  // Observed ahead of now so it stays fresh for the whole file.
  await session.query(
    `INSERT INTO heartbeats (component, instance_key, observed_at, detail)
     VALUES ('worker', 'apply-world', now() + interval '1 day', '{"call_transcribe": true}'::jsonb)`,
  );

  const connections: SessionQueryable[] = [];

  async function newFirm(options: { readonly opportunity?: 'open' | 'closed' | 'none'; readonly timeZone?: string | null } = {}): Promise<TestFirm> {
    firmCounter += 1;
    const n = firmCounter;
    const zone = options.timeZone === undefined ? 'America/New_York' : options.timeZone;
    const { rows: firms } = await session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id, website, locality, region_code, postal_code,
                          time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
       VALUES ($1, $2, $3, $4, 'Providence', 'RI', '02903', $5,
               CASE WHEN $5::text IS NULL THEN NULL ELSE 'medium' END,
               CASE WHEN $5::text IS NULL THEN NULL ELSE 'state_default' END,
               CASE WHEN $5::text IS NULL THEN NULL ELSE 'firm-zone.1' END)
       RETURNING id`,
      [workspaceId, `Apply Test Firm ${String(n)}`, seeded.alpha.salesperson.userId, `https://apply-${String(n)}.example.test`, zone],
    );
    const firmId = firms[0]?.id ?? '';
    const { rows: contacts } = await session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name, title, is_primary)
       VALUES ($1, $2, 'Dana Example', 'Operations Lead', true) RETURNING id`,
      [workspaceId, firmId],
    );
    const contactId = contacts[0]?.id ?? '';
    const e164 = `+1401555${String(1000 + n).slice(-4)}`;
    const { rows: routes } = await session.query<{ id: string; version: number }>(
      `INSERT INTO phone_routes (workspace_id, firm_id, contact_id, e164, source, retrieved_at,
                                 association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
               0.900, 'passed', 'usable', 'route-policy.1')
       RETURNING id, version`,
      [workspaceId, firmId, contactId, e164],
    );
    const opportunity = options.opportunity ?? 'none';
    if (opportunity !== 'none') {
      const stageId = await firstStageId(session, workspaceId);
      const { rows: opened } = await session.query<{ id: string }>(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at, opened_at, status, closed_at, close_reason)
         VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00', TIMESTAMPTZ '2026-09-01 12:00:00+00', $4,
                 CASE WHEN $4 = 'open' THEN NULL ELSE TIMESTAMPTZ '2026-09-02 12:00:00+00' END,
                 CASE WHEN $4 = 'open' THEN NULL ELSE 'Not a fit this year' END)
         RETURNING id`,
        [workspaceId, firmId, stageId, opportunity === 'open' ? 'open' : 'lost'],
      );
      await session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind, occurred_at)
         VALUES ($1, $2, $3, $4, 'system', TIMESTAMPTZ '2026-09-01 12:00:00+00')`,
        [workspaceId, opened[0]?.id, firmId, stageId],
      );
    }
    return { firmId, contactId, routeId: routes[0]?.id ?? '', routeVersion: routes[0]?.version ?? 1, e164 };
  }

  let callCounter = 0;
  async function placeCall(firm: TestFirm, utterances: readonly CallTranscriptUtterance[], options: PlaceOptions = {}): Promise<PlacedCall> {
    callCounter += 1;
    const created = await withTransaction(session, async () =>
      await createCallSession(salesperson(), {
        firmId: firm.firmId,
        contactId: firm.contactId,
        routeId: firm.routeId,
        routeVersion: firm.routeVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId: `apply-call-${String(callCounter)}-${randomBytes(4).toString('hex')}`,
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      }),
    );
    if (!created.ok) throw new Error(`createCallSession: ${created.reason}`);
    const sessionId = created.value.sessionId;
    const callSid = `CA${randomBytes(16).toString('hex')}`;
    const consumed = await withTransaction(session, async () =>
      await consumeCallSession(session, {
        workspaceId,
        sessionId,
        callSid,
        identity: `client:${seeded.alpha.salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
    if (!consumed.ok) throw new Error(`consumeCallSession: ${consumed.reason}`);
    // Placed on an earlier day, so the firm's calling cadence never refuses the next call.
    await session.query(
      "UPDATE call_sessions SET consumed_at = '2026-08-03T14:00:00Z', expires_at = GREATEST(expires_at, '2026-08-03T14:00:00Z') WHERE id = $1",
      [sessionId],
    );
    const statuses = options.statuses ?? [{ status: 'in-progress' }, { status: 'completed', seconds: 125 }];
    for (const delivery of statuses) {
      await withTransaction(session, async () =>
        await recordCallStatus(session, {
          callSid,
          providerStatus: delivery.status,
          ...(delivery.seconds === undefined ? {} : { durationSeconds: delivery.seconds }),
        }),
      );
    }
    const recording = options.recordingSeconds === undefined ? 125 : options.recordingSeconds;
    if (recording !== null) {
      await withTransaction(session, async () =>
        await recordCallRecording(session, {
          callSid,
          recordingSid: `RE${randomBytes(16).toString('hex')}`,
          recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${randomBytes(16).toString('hex')}`,
          durationSeconds: recording,
        }),
      );
    }
    if (options.transcript !== false) {
      await session.query(
        `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
         VALUES ($1, $2, 'aws_transcribe', 'standard', 'en-US', 125, $3::jsonb)`,
        [workspaceId, sessionId, JSON.stringify(utterances)],
      );
    }
    return { sessionId, callSid, firm, utterances };
  }

  async function read(sessionId: string): Promise<CallAnalysisResponse> {
    const value = await readCallAnalysis(salesperson(), sessionId);
    if (value === null) throw new Error('no analysis read');
    return value;
  }

  async function analyse(call: PlacedCall, rawAnswer: string, db: SessionQueryable = session): Promise<Analysed> {
    const version = await withTransaction(db, async () =>
      await createAnalysisVersion(system(db), {
        sessionId: call.sessionId,
        origin: 'model',
        reason: 'transcript',
        model: 'claude-haiku-4-5-20251001',
      }),
    );
    if (version.kind !== 'created') throw new Error(`createAnalysisVersion: ${version.kind}`);
    const completed = await withTransaction(db, async () => {
      const policyContext = await readPolicyContext(system(db), call.sessionId);
      if (policyContext === null) throw new Error('no policy context');
      return await completeCallAnalysis(system(db), {
        analysisId: version.analysisId,
        rawAnswer,
        utterances: call.utterances,
        policyContext,
      });
    });
    if (completed.kind !== 'completed') throw new Error(`completeCallAnalysis: ${JSON.stringify(completed)}`);
    const shown = await read(call.sessionId);
    const authoritative = shown.authoritative;
    if (authoritative === null) throw new Error('no authoritative analysis');
    return {
      ...call,
      analysisId: authoritative.analysisId,
      version: authoritative.version,
      transcriptSha256: authoritative.transcriptSha256,
      proposalHash: authoritative.proposalHash,
      keys: authoritative.proposals.map(proposal => proposal.key),
    };
  }

  return {
    database,
    session,
    seeded,
    crm,
    policy,
    async connection() {
      const opened = await database.appRuntimeSession();
      connections.push(opened);
      return opened;
    },
    system,
    salesperson,
    admin,
    newFirm,
    placeCall,
    analyse,
    read,
    async setTranscription(enabled: boolean) {
      await setting('call_transcription', { enabled, dailyCeilingCents: enabled ? 100 : 0, unitPriceMicros: 4_300 });
    },
    async drop() {
      await database.drop();
    },
  };
}

/** An Apply as the route runs it: the analysis David saw, the selected keys, in one transaction. */
/** An atomic Apply's refusal that names the key it refused on (review S3B: atomic Apply). */
export function refusedAt(reason: string, key: string) {
  return { ok: false, reason, keyReasons: { [key]: reason } };
}

export async function apply(
  world: ApplyWorld,
  shown: Analysed,
  keys: readonly string[],
  options: { readonly db?: SessionQueryable; readonly commandId?: string; readonly edits?: CallProposalEdits; readonly proposalHash?: string; readonly transcriptSha256?: string; readonly analysisId?: string } = {},
): Promise<ApplyCallProposalsOutcome> {
  const db = options.db ?? world.session;
  return await withTransaction(db, async () =>
    await applyCallProposals(world.salesperson(db), {
      analysisId: options.analysisId ?? shown.analysisId,
      transcriptSha256: options.transcriptSha256 ?? shown.transcriptSha256,
      proposalHash: options.proposalHash ?? shown.proposalHash,
      keys,
      ...(options.edits === undefined ? {} : { edits: options.edits }),
      commandId: options.commandId ?? `apply-${randomBytes(6).toString('hex')}`,
      journal: recordingSuppressionJournal(),
    }),
  );
}

/** Whether any backend other than `asker`'s is waiting on `blockerPid` (pg_blocking_pids). */
export async function waitsOn(asker: SessionQueryable, blockerPid: number, attempts = 150): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { rows } = await asker.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND $1::int = ANY(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (Number(rows[0]?.count ?? 0) > 0) return true;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

export const pidOf = async (db: SessionQueryable): Promise<number> =>
  Number((await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
