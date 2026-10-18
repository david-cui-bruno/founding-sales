import { linkedinManualReadSchema, linkedinManualViewSchema, type LinkedinManualEntry, type LinkedinManualView } from '@fss/contracts';
import type { z } from 'zod';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { activeIdentityActor } from './identityAccess.ts';
import { accessibleManualLedger, currentManualBinding, manualBindingChoices, type ManualLedgerRow } from './linkedinManualAccess.ts';

interface HistoryRow {
  ledger_id: string; entry_id: string; revision: number; sequence: string;
  kind: LinkedinManualEntry['kind']; connection_state: LinkedinManualEntry['connectionState'];
  occurred_at: Date; recorded_at: Date; voided: boolean; correction: LinkedinManualEntry['correction'];
  [key: string]: unknown;
}
async function ledgerProjection(ctx: RepositoryContext, row: ManualLedgerRow): Promise<LinkedinManualView['ledgers'][number]> {
  const binding = await currentManualBinding(ctx, {
    ledgerId: row.id, accountId: row.account_id, personId: row.person_id, firmId: row.firm_id,
    claimId: row.claim_id, claimRevision: row.claim_revision, relationshipId: row.relationship_id, relationshipRevision: row.relationship_revision,
  });
  const state = (await ctx.db.query<{ connection_state: LinkedinManualView['ledgers'][number]['connectionState'] }>(`SELECT connection_state FROM (
    SELECT DISTINCT ON(entry_id) * FROM linkedin_manual_entries WHERE workspace_id=$1 AND ledger_id=$2 ORDER BY entry_id,revision DESC
    ) current_entries WHERE kind='connection' AND NOT voided ORDER BY occurred_at DESC,entry_id DESC LIMIT 1`, [ctx.scope.workspaceId, row.id])).rows[0];
  const stopped = (await ctx.db.query(`SELECT 1 FROM linkedin_manual_stops WHERE workspace_id=$1 AND (person_id=$2 OR firm_id=$3) LIMIT 1`, [ctx.scope.workspaceId, row.person_id, row.firm_id])).rows.length > 0;
  return {
    id: row.id, accountId: row.account_id, personId: row.person_id, firmId: row.firm_id,
    personName: binding?.person_name ?? null, firmName: binding?.firm_name ?? null, profile: binding?.profile ?? null,
    bindingCurrent: binding !== null, connectionState: state?.connection_state ?? 'unknown',
    handoffRequired: stopped, sendingPermission: false, nativeObservation: false,
  };
}

/** Bounded history pages retain originals and corrections. Reads never grant follow-up. */
export async function readLinkedinManual(ctx: RepositoryContext, input: z.infer<typeof linkedinManualReadSchema>): Promise<LinkedinManualView | null> {
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user' || !await activeIdentityActor(ctx) || !linkedinManualReadSchema.safeParse(input).success) return null;
  const rows = (await ctx.db.query<ManualLedgerRow>(`SELECT * FROM linkedin_manual_ledgers WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY id LIMIT 100`, [ctx.scope.workspaceId, actor.userId])).rows;
  if (input.ledgerId && !rows.some(row => row.id === input.ledgerId)) {
    const selected = await accessibleManualLedger(ctx, input.ledgerId);
    if (!selected) return null;
    rows.push(selected);
  }
  const ledgers: LinkedinManualView['ledgers'] = [];
  for (const row of rows) {
    if (await accessibleManualLedger(ctx, row.id)) ledgers.push(await ledgerProjection(ctx, row));
  }
  if (input.ledgerId && !ledgers.some(row => row.id === input.ledgerId)) return null;
  const historyRows = input.ledgerId ? (await ctx.db.query<HistoryRow>(`SELECT * FROM linkedin_manual_entries WHERE workspace_id=$1 AND ledger_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint) ORDER BY sequence DESC LIMIT 51`, [ctx.scope.workspaceId, input.ledgerId, input.before ?? null])).rows : [];
  const accounts = (await ctx.db.query<{ id: string; display_name: string }>(`SELECT id,display_name FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND platform='linkedin' AND account_kind='profile' AND state<>'disconnected' ORDER BY id LIMIT 30`, [ctx.scope.workspaceId, actor.userId])).rows;
  const choices = await manualBindingChoices(ctx);
  if (!await activeIdentityActor(ctx)) return null;
  return linkedinManualViewSchema.parse({
    accounts: accounts.map(row => ({ id: row.id, displayName: row.display_name })), choices, ledgers,
    history: historyRows.slice(0, 50).map(row => ({
      ledgerId: row.ledger_id, entryId: row.entry_id, expectedRevision: row.revision - 1, revision: row.revision,
      sequence: row.sequence, kind: row.kind, connectionState: row.connection_state,
      occurredAt: row.occurred_at.toISOString(), recordedAt: row.recorded_at.toISOString(), voided: row.voided,
      correction: row.correction, ownerAssertion: true, channel: 'linkedin',
    })),
    nextBefore: historyRows.length > 50 ? historyRows[49]!.sequence : null,
    coverage: 'manual_owner_assertions_only',
  });
}
