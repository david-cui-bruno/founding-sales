import { z } from 'zod';
import type { AppDatabase } from '../db/database';
import type { Clock } from '../domain/support/clock';
import { accountIdSchema as id, accountInstantSchema, accountSchema } from '../../shared/contracts/accountContract';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import type { DiscoveryReservationInput, DiscoveryReservationResult, DiscoveryReservationStore } from '../research/companyResearchTypes';
const cost = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const keySchema = z.strictObject({ commandId: id, workspaceId: id, budgetId: id, inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
const inputSchema = keySchema.extend({ searchCostMicros: cost, modelCostMicros: cost }).refine(v => Number.isSafeInteger(v.searchCostMicros + v.modelCostMicros), 'Unsafe total');
const candidatesSchema = z.array(z.strictObject({ name: accountSchema.shape.name, domain: accountSchema.shape.domain.unwrap(),
  sourceUrl: z.url().max(2048).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }) })).max(50);
const completeSchema = keySchema.extend({ candidates: candidatesSchema, costMicros: cost.nullable() });
type ReservationRow = { input_fingerprint: string; search_cost_micros: number; model_cost_micros: number };
/** No network, timers or automatic grants. An uncertain reservation is never reusable. */
export class SqlDiscoveryReservationStore implements DiscoveryReservationStore {
  constructor(private readonly deps: { database: AppDatabase; workspaceId: string; clock: Clock }) { id.parse(deps.workspaceId); }
  private get raw() { return this.deps.database.raw; }
  private now() { return accountInstantSchema.parse(this.deps.clock.now()); }
  private atomic<T>(run: () => T): T {
    if (this.raw.inTransaction) throw new Error('Reservation requires its own transaction');
    return this.raw.transaction(run).immediate();
  }
  /** Explicit approved-budget admission, never called by reserve or constructors. */
  approveBudget(input: { budgetId: string; ceilingMicros: number; evidenceRef: string }): void {
    const value = z.strictObject({ budgetId: id, ceilingMicros: cost, evidenceRef: id }).parse(input);
    this.atomic(() => {
      const old = this.raw.prepare('SELECT ceiling_micros,evidence_ref FROM discovery_approved_budgets WHERE workspace_id=? AND budget_id=?')
        .get(this.deps.workspaceId, value.budgetId) as { ceiling_micros: number; evidence_ref: string } | undefined;
      if (old) {
        if (old.ceiling_micros !== value.ceilingMicros || old.evidence_ref !== value.evidenceRef) throw new Error('Budget approval conflict');
      } else this.raw.prepare('INSERT INTO discovery_approved_budgets VALUES(?,?,?,?,?)').run(this.deps.workspaceId, value.budgetId, value.ceilingMicros, this.now(), value.evidenceRef);
    });
  }
  reserveOnce(input: DiscoveryReservationInput): DiscoveryReservationResult {
    const value = inputSchema.parse(input);
    if (value.workspaceId !== this.deps.workspaceId) throw new Error('Workspace reservation mismatch');
    return this.atomic(() => {
      const old = this.reservation(value);
      if (old) {
        if (old.input_fingerprint !== value.inputFingerprint || old.search_cost_micros !== value.searchCostMicros || old.model_cost_micros !== value.modelCostMicros) throw new Error('Reservation fingerprint conflict');
        const receipt = this.receipt(value);
        return { status: 'replay', candidates: receipt ? candidatesSchema.parse(JSON.parse(receipt.candidates_json)) : null };
      }
      const budget = this.raw.prepare('SELECT ceiling_micros FROM discovery_approved_budgets WHERE workspace_id=? AND budget_id=?')
        .get(value.workspaceId, value.budgetId) as { ceiling_micros: number } | undefined;
      if (!budget) return { status: 'denied' };
      const spent = this.raw.prepare(`SELECT COALESCE(SUM(COALESCE(c.cost_micros,r.search_cost_micros+r.model_cost_micros)),0) AS used
        FROM discovery_reservations r LEFT JOIN discovery_receipts c USING(workspace_id,budget_id,command_id)
        WHERE r.workspace_id=? AND r.budget_id=?`).get(value.workspaceId, value.budgetId) as { used: number };
      if (value.searchCostMicros + value.modelCostMicros > budget.ceiling_micros - spent.used) return { status: 'denied' };
      this.raw.prepare('INSERT INTO discovery_reservations VALUES(?,?,?,?,?,?,?)').run(value.workspaceId, value.budgetId, value.commandId,
        value.inputFingerprint, value.searchCostMicros, value.modelCostMicros, this.now());
      return { status: 'reserved' };
    });
  }
  complete(input: Parameters<DiscoveryReservationStore['complete']>[0]): void {
    const value = completeSchema.parse(input);
    if (value.workspaceId !== this.deps.workspaceId) throw new Error('Workspace receipt mismatch');
    this.atomic(() => {
      const reserved = this.reservation(value);
      if (!reserved || reserved.input_fingerprint !== value.inputFingerprint) throw new Error('Reservation receipt conflict');
      const prior = this.receipt(value);
      if (prior) {
        if (prior.cost_micros !== value.costMicros || accountFingerprint(JSON.parse(prior.candidates_json)) !== accountFingerprint(value.candidates)) throw new Error('Receipt replay conflict');
        return;
      }
      if (value.costMicros !== null && value.costMicros > reserved.search_cost_micros + reserved.model_cost_micros) throw new Error('Spend exceeds reserved ceiling');
      this.raw.prepare('INSERT INTO discovery_receipts VALUES(?,?,?,?,?,?)').run(value.workspaceId, value.budgetId, value.commandId, JSON.stringify(value.candidates), value.costMicros, this.now());
    });
  }
  private reservation(value: z.infer<typeof keySchema>): ReservationRow | undefined {
    return this.raw.prepare('SELECT * FROM discovery_reservations WHERE workspace_id=? AND budget_id=? AND command_id=?')
      .get(value.workspaceId, value.budgetId, value.commandId) as ReservationRow | undefined;
  }
  private receipt(value: z.infer<typeof keySchema>) {
    return this.raw.prepare('SELECT candidates_json,cost_micros FROM discovery_receipts WHERE workspace_id=? AND budget_id=? AND command_id=?')
      .get(value.workspaceId, value.budgetId, value.commandId) as { candidates_json: string; cost_micros: number | null } | undefined;
  }
}
