import {
  ACCEPTANCE_MINIMUM_DECIDED,
  type CallProposal,
  type CallProposalDecision,
  type CallTranscriptUtterance,
  type ProposalAcceptanceResponse,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { lockCallAnalysis } from './analysis.ts';
import { transcriptSha256 } from './analysisModel.ts';

/**
 * The shadow measurement of slice 3a (DESIGN-S3A §2.9): no new table.
 *
 * Every decision David makes about a suggestion is one append-only `audit_events` row,
 * action `call.proposal_decided`, subject the analysis version, with
 * `{analysisId, callSessionId, version, proposalHash, policyVersion, key, kind, type, result}`:
 *
 *   * `unchanged` / `edited` — applied by the Apply (`proposalApply.ts`), as proposed or not;
 *   * `declined` — `POST /calls/proposals/decline`, or a Needs review item dismissed;
 *   * `bypassed` — David logged the call from the form while the call had an
 *     authoritative analysis (`logCallOutcome`, outside an Apply).
 *
 * The latest decision per `(analysisId, key)` is the one counted. `GET
 * /calls/proposals/acceptance` reports it per action type (`acceptanceTypeOf`) with the share
 * accepted unchanged, `insufficient` below five decided suggestions, and every incorrect
 * stop or deal-opening suggestion (declined or edited) by id. It feeds the 10-call
 * checkpoint (David's decision 8); nothing here turns anything automatic.
 */

export const PROPOSAL_DECIDED_ACTION = 'call.proposal_decided';

/**
 * The action type of one suggestion (DESIGN-S3A §2.9): `outcome:<value>` for an outcome other
 * than `do_not_call`; `stop` for the `do_not_call` outcome and `stop_scope`; otherwise the
 * kind (`callback`, `follow_up`, `buying_signal`, `park`, `task`, the review kinds). The
 * proposal's own value, never the edited one: the measurement is of the suggestion.
 */
export function acceptanceTypeOf(proposal: CallProposal | undefined): string {
  if (proposal === undefined) return 'unknown';
  if (proposal.kind === 'outcome') return proposal.params.outcome === 'do_not_call' ? 'stop' : `outcome:${proposal.params.outcome}`;
  if (proposal.kind === 'stop_scope') return 'stop';
  return proposal.kind;
}

export interface MeasuredAnalysis {
  readonly id: string;
  readonly callSessionId: string;
  readonly version: number;
  readonly proposalHash: string;
  readonly policyVersion: string | null;
  readonly proposals: readonly CallProposal[];
}

/** Write one decision row per key, in the caller's transaction. */
export async function recordProposalDecisions(
  context: RepositoryContext,
  analysis: MeasuredAnalysis,
  decisions: readonly { readonly key: string; readonly result: CallProposalDecision }[],
): Promise<void> {
  const byKey = new Map(analysis.proposals.map(proposal => [proposal.key, proposal] as const));
  for (const decision of decisions) {
    const proposal = byKey.get(decision.key);
    await recordCrmAuditEvent(context, {
      action: PROPOSAL_DECIDED_ACTION,
      subjectKind: 'call_analysis',
      subjectId: analysis.id,
      detail: {
        analysisId: analysis.id,
        callSessionId: analysis.callSessionId,
        version: analysis.version,
        proposalHash: analysis.proposalHash,
        policyVersion: analysis.policyVersion,
        key: decision.key,
        kind: proposal?.kind ?? null,
        type: acceptanceTypeOf(proposal),
        result: decision.result,
      },
    });
  }
}

type AnalysisRow = {
  readonly id: string;
  readonly call_session_id: string;
  readonly version: number;
  readonly proposal_hash: string;
  readonly policy_version: string | null;
  readonly proposals: CallProposal[];
};

/**
 * The session's authoritative analysis — the newest completed model version on the current
 * transcript — or null. A read; the caller decides what locks it needs.
 */
export async function authoritativeAnalysis(context: RepositoryContext, sessionId: string): Promise<MeasuredAnalysis | null> {
  const { rows: transcripts } = await context.db.query<{ utterances: unknown }>(
    'SELECT utterances FROM call_transcripts WHERE workspace_id = $1 AND call_session_id = $2',
    [context.scope.workspaceId, sessionId],
  );
  const transcript = transcripts[0];
  if (transcript === undefined) return null;
  const sha = transcriptSha256(Array.isArray(transcript.utterances) ? (transcript.utterances as CallTranscriptUtterance[]) : []);
  const { rows } = await context.db.query<AnalysisRow>(
    `SELECT id, call_session_id, version, proposal_hash, policy_version, proposals
       FROM call_analyses
      WHERE workspace_id = $1 AND call_session_id = $2 AND origin = 'model' AND state = 'completed'
        AND transcript_sha256 = $3
      ORDER BY version DESC LIMIT 1`,
    [context.scope.workspaceId, sessionId, sha],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    callSessionId: row.call_session_id,
    version: row.version,
    proposalHash: row.proposal_hash,
    policyVersion: row.policy_version,
    proposals: row.proposals,
  };
}

/**
 * `bypassed` for what the form logged on a call that had an authoritative analysis: the
 * `outcome` suggestion, and the `callback` and `follow_up` suggestions when the form made a
 * callback or recorded an agreement. Only suggestions with no decision yet.
 */
export async function recordFormBypass(
  context: RepositoryContext,
  input: { readonly sessionId: string; readonly callback: boolean; readonly followUp: boolean },
): Promise<void> {
  const analysis = await authoritativeAnalysis(context, input.sessionId);
  if (analysis === null) return;
  const wanted = new Set(['outcome', ...(input.callback ? ['callback'] : []), ...(input.followUp ? ['follow_up'] : [])]);
  const decided = await decidedKeys(context, analysis.id);
  const keys = analysis.proposals.map(proposal => proposal.key).filter(key => wanted.has(key) && !decided.has(key));
  await recordProposalDecisions(context, analysis, keys.map(key => ({ key, result: 'bypassed' as const })));
}

async function decidedKeys(context: RepositoryContext, analysisId: string): Promise<ReadonlySet<string>> {
  const { rows } = await context.db.query<{ key: string }>(
    `SELECT DISTINCT detail->>'key' AS key FROM audit_events
      WHERE workspace_id = $1 AND action = $2 AND subject_kind = 'call_analysis' AND subject_id = $3`,
    [context.scope.workspaceId, PROPOSAL_DECIDED_ACTION, analysisId],
  );
  return new Set(rows.map(row => row.key));
}

// ---------------------------------------------------------------------------
// Decline
// ---------------------------------------------------------------------------

export type DeclineOutcome =
  | { readonly ok: true; readonly value: { readonly analysisId: string; readonly declined: readonly string[] } }
  | { readonly ok: false; readonly reason: 'not_found' | 'not_assigned' | 'invalid_input' | 'stale_analysis' | 'stale_proposal' | 'proposal_unknown' };

/**
 * `POST /calls/proposals/decline`: the measurement only. Any proposal of the authoritative
 * analysis, `apply` or `review` (dismissing a review item is declining it). Nothing else is
 * written, and a declined proposal stays applicable. Firm → `call_analysis:<session>`, the
 * prefix of the one order; no gate, because nothing here can stop a send.
 */
export async function declineCallProposals(
  context: RepositoryContext,
  input: { readonly analysisId: string; readonly proposalHash: string; readonly keys: readonly string[] },
): Promise<DeclineOutcome> {
  if (context.scope.actor.kind !== 'user') return { ok: false, reason: 'invalid_input' };
  const { rows: located } = await context.db.query<{ call_session_id: string; firm_id: string }>(
    `SELECT a.call_session_id, s.firm_id FROM call_analyses a
       JOIN call_sessions s ON s.workspace_id = a.workspace_id AND s.id = a.call_session_id
      WHERE a.workspace_id = $1 AND a.id = $2`,
    [context.scope.workspaceId, input.analysisId],
  );
  const where = located[0];
  if (where === undefined) return { ok: false, reason: 'not_found' };
  const firm = await loadFirmForUpdate(context, where.firm_id);
  if (firm === null) return { ok: false, reason: 'not_found' };
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return { ok: false, reason: decision.reason === 'not_assigned' ? 'not_assigned' : 'not_found' };
  await lockCallAnalysis(context, where.call_session_id);
  const analysis = await authoritativeAnalysis(context, where.call_session_id);
  if (analysis === null || analysis.id !== input.analysisId) return { ok: false, reason: 'stale_analysis' };
  if (analysis.proposalHash !== input.proposalHash) return { ok: false, reason: 'stale_proposal' };
  const known = new Set(analysis.proposals.map(proposal => proposal.key));
  if (input.keys.length === 0 || input.keys.some(key => !known.has(key))) return { ok: false, reason: 'proposal_unknown' };
  await recordProposalDecisions(context, analysis, input.keys.map(key => ({ key, result: 'declined' as const })));
  return { ok: true, value: { analysisId: analysis.id, declined: [...input.keys] } };
}

// ---------------------------------------------------------------------------
// The acceptance read
// ---------------------------------------------------------------------------

type DecisionRow = {
  readonly analysis_id: string;
  readonly call_session_id: string;
  readonly key: string;
  readonly type: string;
  readonly result: CallProposalDecision;
  readonly occurred_at: Date;
};

/** `GET /calls/proposals/acceptance`, per action type, over the workspace. */
export async function readProposalAcceptance(context: RepositoryContext): Promise<ProposalAcceptanceResponse> {
  // The latest decision per (analysis, key).
  const { rows: decisions } = await context.db.query<DecisionRow>(
    `SELECT DISTINCT ON (detail->>'analysisId', detail->>'key')
            detail->>'analysisId' AS analysis_id, detail->>'callSessionId' AS call_session_id,
            detail->>'key' AS key, detail->>'type' AS type, detail->>'result' AS result, occurred_at
       FROM audit_events
      WHERE workspace_id = $1 AND action = $2
      ORDER BY detail->>'analysisId', detail->>'key', occurred_at DESC, id DESC`,
    [context.scope.workspaceId, PROPOSAL_DECIDED_ACTION],
  );
  // Undecided: every suggestion of each call's authoritative analysis with no decision.
  const { rows: sessions } = await context.db.query<{ id: string }>(
    `SELECT DISTINCT a.call_session_id AS id FROM call_analyses a
      WHERE a.workspace_id = $1 AND a.origin = 'model' AND a.state = 'completed'`,
    [context.scope.workspaceId],
  );
  const decided = new Set(decisions.map(row => `${row.analysis_id}\u0000${row.key}`));
  const undecided = new Map<string, number>();
  for (const session of sessions) {
    const analysis = await authoritativeAnalysis(context, session.id);
    if (analysis === null) continue;
    for (const proposal of analysis.proposals) {
      if (decided.has(`${analysis.id}\u0000${proposal.key}`)) continue;
      const type = acceptanceTypeOf(proposal);
      undecided.set(type, (undecided.get(type) ?? 0) + 1);
    }
  }

  const counts = new Map<string, { unchanged: number; edited: number; declined: number; bypassed: number }>();
  const bucket = (type: string) => {
    const existing = counts.get(type);
    if (existing !== undefined) return existing;
    const fresh = { unchanged: 0, edited: 0, declined: 0, bypassed: 0 };
    counts.set(type, fresh);
    return fresh;
  };
  for (const row of decisions) bucket(row.type)[row.result] += 1;
  for (const type of undecided.keys()) bucket(type);

  const types = [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([type, c]) => {
      const decidedCount = c.unchanged + c.edited + c.declined + c.bypassed;
      return {
        type,
        ...c,
        undecided: undecided.get(type) ?? 0,
        acceptedUnchangedShare: decidedCount === 0 ? null : c.unchanged / decidedCount,
        insufficient: decidedCount < ACCEPTANCE_MINIMUM_DECIDED,
      };
    });
  const incorrect = decisions
    .filter(
      (row): row is DecisionRow & { result: 'declined' | 'edited' } =>
        (row.type === 'buying_signal' || row.type === 'stop') && (row.result === 'declined' || row.result === 'edited'),
    )
    .map(row => ({
      analysisId: row.analysis_id,
      callSessionId: row.call_session_id,
      key: row.key,
      type: row.type as 'buying_signal' | 'stop',
      result: row.result,
      decidedAt: row.occurred_at.toISOString(),
    }));
  return { minimumDecided: ACCEPTANCE_MINIMUM_DECIDED, types, incorrect };
}
