import { linkedinManualBindSchema, linkedinManualRecordSchema, type LinkedinManualBind, type LinkedinManualRecord } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { activeIdentityActor } from './identityAccess.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { accessibleManualLedger, currentManualBinding, type ManualLedgerRow } from './linkedinManualAccess.ts';
import { stopLinkedinManualFollowup } from './linkedinManualStops.ts';

const refused = (reason: string) => ({ ok: false as const, reason });
const saved = (ledgerId: string, entryId: string | null, revision: number) => ({ ok: true as const, value: { ledgerId, entryId, revision } });
const bindFields = (input: LinkedinManualBind) => [input.accountId, input.personId, input.firmId, input.claimId, input.claimRevision, input.relationshipId, input.relationshipRevision];
const rowFields = (row: ManualLedgerRow) => [row.account_id, row.person_id, row.firm_id, row.claim_id, row.claim_revision, row.relationship_id, row.relationship_revision];

/** All callers run one transaction. Never acquires a LinkedIn session or performs outreach. */
export async function bindLinkedinManual(ctx: RepositoryContext, input: LinkedinManualBind) {
  if (!linkedinManualBindSchema.safeParse(input).success) return refused('invalid_input');
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user' || !await activeIdentityActor(ctx)) return refused('not_found');
  await lockSendGateForStopFact(ctx);
  const account = (await ctx.db.query('SELECT 1 FROM social_accounts WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND platform=\'linkedin\' AND account_kind=\'profile\' AND state<>\'disconnected\' FOR UPDATE', [ctx.scope.workspaceId, input.accountId, actor.userId])).rows[0];
  if (!account || !await currentManualBinding(ctx, input)) return refused('binding_unavailable');
  const old = (await ctx.db.query<ManualLedgerRow>('SELECT * FROM linkedin_manual_ledgers WHERE workspace_id=$1 AND id=$2', [ctx.scope.workspaceId, input.ledgerId])).rows[0];
  if (old) return old.owner_user_id === actor.userId && JSON.stringify(rowFields(old)) === JSON.stringify(bindFields(input)) ? saved(old.id, null, 0) : refused('binding_conflict');
  const duplicate = (await ctx.db.query<{ id: string }>('SELECT id FROM linkedin_manual_ledgers WHERE workspace_id=$1 AND owner_user_id=$2 AND account_id=$3 AND person_id=$4 AND firm_id=$5 AND claim_id=$6 AND claim_revision=$7 AND relationship_id=$8 AND relationship_revision=$9', [ctx.scope.workspaceId, actor.userId, ...bindFields(input)])).rows[0];
  if (duplicate) return refused('binding_already_recorded');
  await ctx.db.query(`INSERT INTO linkedin_manual_ledgers(workspace_id,id,owner_user_id,account_id,person_id,firm_id,claim_id,claim_revision,relationship_id,relationship_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ctx.scope.workspaceId, input.ledgerId, actor.userId, ...bindFields(input)]);
  // A new account/profile association cannot bypass a previously recorded person stop.
  const stop = (await ctx.db.query<{ entry_id: string; entry_revision: number }>('SELECT entry_id,entry_revision FROM linkedin_manual_stops WHERE workspace_id=$1 AND person_id=$2 ORDER BY created_at LIMIT 1', [ctx.scope.workspaceId, input.personId])).rows[0];
  if (stop) await stopLinkedinManualFollowup(ctx, (await accessibleManualLedger(ctx, input.ledgerId))!, stop.entry_id, stop.entry_revision);
  await recordCrmAuditEvent(ctx, { action: 'linkedin.manual_bound', subjectKind: 'person', subjectId: input.personId, detail: { ledgerId: input.ledgerId, accountId: input.accountId, firmId: input.firmId, source: 'owner_assertion', sendingPermission: false } });
  return saved(input.ledgerId, null, 0);
}

interface EntryRow {
  ledger_id: string; entry_id: string; revision: number; kind: LinkedinManualRecord['kind'];
  connection_state: LinkedinManualRecord['connectionState']; occurred_at: Date;
  voided: boolean; correction: LinkedinManualRecord['correction']; [key: string]: unknown;
}
const entryPayload = (row: EntryRow) => [row.ledger_id, row.kind, row.connection_state, row.occurred_at.toISOString(), row.voided, row.correction];
const inputPayload = (input: LinkedinManualRecord) => [input.ledgerId, input.kind, input.connectionState, new Date(input.occurredAt).toISOString(), input.voided, input.correction];

export async function recordLinkedinManual(ctx: RepositoryContext, input: LinkedinManualRecord) {
  if (!linkedinManualRecordSchema.safeParse(input).success) return refused('invalid_input');
  // Gate first: a committed reply/refusal is ordered against all external-action claims.
  await lockSendGateForStopFact(ctx);
  const ledger = await accessibleManualLedger(ctx, input.ledgerId);
  if (!ledger || ctx.scope.actor.kind !== 'user') return refused('not_found');
  if ((await ctx.db.query<{ future: boolean }>('SELECT $1::timestamptz>clock_timestamp() AS future', [input.occurredAt])).rows[0]!.future) return refused('future_activity');
  const previous = (await ctx.db.query<EntryRow>('SELECT * FROM linkedin_manual_entries WHERE workspace_id=$1 AND entry_id=$2 ORDER BY revision DESC LIMIT 1', [ctx.scope.workspaceId, input.entryId])).rows[0];
  const revision = input.expectedRevision + 1;
  if (previous && previous.revision >= revision) {
    const original = (await ctx.db.query<EntryRow>('SELECT * FROM linkedin_manual_entries WHERE workspace_id=$1 AND entry_id=$2 AND revision=$3', [ctx.scope.workspaceId, input.entryId, revision])).rows[0];
    return original && JSON.stringify(entryPayload(original)) === JSON.stringify(inputPayload(input)) ? saved(input.ledgerId, input.entryId, revision) : refused('entry_conflict');
  }
  if ((previous?.revision ?? 0) !== input.expectedRevision || (previous && previous.ledger_id !== input.ledgerId)) return refused('entry_conflict');
  await ctx.db.query(`INSERT INTO linkedin_manual_entries(workspace_id,ledger_id,entry_id,revision,kind,connection_state,occurred_at,voided,correction,actor_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [ctx.scope.workspaceId, input.ledgerId, input.entryId, revision, input.kind, input.connectionState, input.occurredAt, input.voided, input.correction, ctx.scope.actor.userId]);
  // Even a later correction to a reply/refusal keeps the original restrictive stop.
  if (input.kind === 'reply' || input.kind === 'refusal') await stopLinkedinManualFollowup(ctx, ledger, input.entryId, revision);
  await recordCrmAuditEvent(ctx, { action: 'linkedin.manual_recorded', subjectKind: 'person', subjectId: ledger.person_id, detail: { ledgerId: ledger.id, entryId: input.entryId, revision, kind: input.kind, source: 'owner_assertion' } });
  return saved(input.ledgerId, input.entryId, revision);
}
