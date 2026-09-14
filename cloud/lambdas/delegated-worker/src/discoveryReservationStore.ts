import { z } from 'zod';
import { accountIdSchema, accountInstantSchema, accountSchema } from '../../../../src/shared/contracts/accountContract';
import type { DiscoveryReservationInput, DiscoveryReservationStore, DiscoveryReservationResult } from '../../../../src/main/research/companyResearchTypes';
import { DynamoStore, fingerprint, integer, keyPart, type RepositoryOptions, type Stored } from './dynamoStore';
export const budgetSchema = z.strictObject({ limit: integer.positive(), spent: integer, approvedAt: accountInstantSchema });
export type Budget = z.infer<typeof budgetSchema>;
const inputSchema = z.strictObject({ commandId: z.uuid(), workspaceId: accountIdSchema, budgetId: accountIdSchema,
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), searchCostMicros: integer.positive(), modelCostMicros: integer.positive() });
const candidatesSchema = z.array(z.strictObject({ name: accountSchema.shape.name, domain: accountSchema.shape.domain.unwrap(), sourceUrl: z.url().max(2048) })).max(50);
export const researchOnceBindingSchema = z.strictObject({ pairingId: z.uuid(), researchFingerprint: z.string().regex(/^[a-f0-9]{64}$/), sourceRevision: integer.positive() });
type ReservationOptions = RepositoryOptions & { researchOnceBinding?: z.infer<typeof researchOnceBindingSchema> };
const reservationSchema = inputSchema.extend({ reserved: integer.positive(), candidates: candidatesSchema.nullable(), costMicros: integer.nullable(), completed: z.boolean(), researchOnceBinding: researchOnceBindingSchema.optional() });
type Record = z.infer<typeof reservationSchema>;
export const budgetKey = (id: string) => `BUDGET#discovery#${keyPart(id)}`;
export const reservationKey = (id: string) => `DISCOVERY#${keyPart(id)}`;
export const researchAdmissionKey = 'RESEARCH_ADMISSION_FENCE';
/** Pure immutable budget planning shared by authenticated atomic admission. */
export function planDiscoveryBudget(store: DynamoStore, input: { budgetId: string; limitMicros: number }) {
  const budget = budgetSchema.parse({ limit: input.limitMicros, spent: 0, approvedAt: store.now() });
  return store.put(budgetKey(input.budgetId), budget, null, { limit: budget.limit, spent: 0 });
}
export class DynamoDiscoveryReservationStore implements DiscoveryReservationStore {
  private readonly store: DynamoStore;
  constructor(private readonly options: ReservationOptions) { this.store = new DynamoStore(options); }
  async readRunWithRevision(id: string) {
    const row = await this.store.get<unknown>(reservationKey(z.uuid().parse(id)));
    if (!row) return null;
    const data = reservationSchema.parse(row.data);
    if (data.commandId !== id || data.workspaceId !== this.store.options.workspaceId) throw new Error('discovery_fingerprint_conflict');
    return { data, rev: row.rev };
  }
  async readRun(id: string) { return (await this.readRunWithRevision(id))?.data ?? null; }
  /** Operator/authenticated configuration capability, never invoked by preparation
   * or a constructor. Immutable ceiling: new UUIDs cannot reset spent. */
  async approveBudget(input: { budgetId: string; limitMicros: number }): Promise<void> {
    const source = await this.store.get('OWNER_RESEARCH_SOURCE');
    const admission = await this.store.get(researchAdmissionKey);
    await this.store.transact([this.store.put(researchAdmissionKey, { version: 1, kind: 'legacy' }, admission?.rev ?? null), planDiscoveryBudget(this.store, input), this.store.absent('GUIDED_RESEARCH_SETUP'), source ? this.store.check('OWNER_RESEARCH_SOURCE', source.rev) : this.store.absent('OWNER_RESEARCH_SOURCE')]);
  }
  private replay(record: Stored<Record>, input: DiscoveryReservationInput): DiscoveryReservationResult {
    const prior = reservationSchema.parse(record.data);
    if (this.options.researchOnceBinding && fingerprint(prior.researchOnceBinding ?? null) !== fingerprint(this.options.researchOnceBinding)) throw new Error('research_once_binding_conflict');
    if (fingerprint({ commandId: prior.commandId, workspaceId: prior.workspaceId, budgetId: prior.budgetId, inputFingerprint: prior.inputFingerprint, searchCostMicros: prior.searchCostMicros, modelCostMicros: prior.modelCostMicros }) !== fingerprint(input)) throw new Error('discovery_fingerprint_conflict');
    return { status: 'replay', candidates: prior.completed ? prior.candidates : null };
  }
  async reserveOnce(input: DiscoveryReservationInput): Promise<DiscoveryReservationResult> {
    const parsed = inputSchema.parse(input); this.store.workspace(parsed.workspaceId);
    const key = reservationKey(parsed.commandId);
    const prior = await this.store.get<Record>(key);
    if (prior) return this.replay(prior, parsed);
    const row = await this.store.get<Budget>(budgetKey(parsed.budgetId));
    if (!row) return { status: 'denied' };
    const budget = budgetSchema.parse(row.data);
    const cost = integer.positive().parse(parsed.searchCostMicros + parsed.modelCostMicros);
    if (budget.spent + cost > budget.limit) return { status: 'denied' };
    const next = { ...budget, spent: budget.spent + cost };
    try {
      await this.store.transact([this.store.put(budgetKey(parsed.budgetId), next, row.rev, { limit: budget.limit, spent: next.spent }, { limit: budget.limit, spent: budget.spent }),
        this.store.put(key, { ...parsed, reserved: cost, candidates: null, costMicros: null, completed: false, ...(this.options.researchOnceBinding ? { researchOnceBinding: researchOnceBindingSchema.parse(this.options.researchOnceBinding) } : {}) }, null)]);
    } catch (error) {
      const committed = await this.store.get<Record>(key);
      if (committed) return this.replay(committed, parsed);
      throw error;
    }
    return { status: 'reserved' };
  }
  async complete(input: Parameters<DiscoveryReservationStore['complete']>[0]): Promise<void> {
    const parsed = z.strictObject({ commandId: z.uuid(), workspaceId: accountIdSchema, budgetId: accountIdSchema,
      inputFingerprint: inputSchema.shape.inputFingerprint, candidates: candidatesSchema, costMicros: integer.nullable() }).parse(input);
    this.store.workspace(parsed.workspaceId);
    const row = await this.store.get<Record>(reservationKey(parsed.commandId));
    if (!row) throw new Error('discovery_reservation_missing');
    const prior = reservationSchema.parse(row.data);
    if (prior.workspaceId !== parsed.workspaceId || prior.budgetId !== parsed.budgetId || prior.inputFingerprint !== parsed.inputFingerprint) throw new Error('discovery_fingerprint_conflict');
    if (prior.completed) {
      if (fingerprint({ candidates: prior.candidates, costMicros: prior.costMicros }) !== fingerprint({ candidates: parsed.candidates, costMicros: parsed.costMicros })) throw new Error('discovery_completion_conflict');
      return;
    }
    if (parsed.costMicros !== null && parsed.costMicros > prior.reserved) throw new Error('cost_exceeds_reservation');
    const writes = [this.store.put(reservationKey(parsed.commandId), { ...prior, candidates: parsed.candidates, costMicros: parsed.costMicros, completed: true }, row.rev)];
    if (parsed.costMicros !== null && parsed.costMicros < prior.reserved) {
      const budgetRow = await this.store.get<Budget>(budgetKey(parsed.budgetId));
      if (!budgetRow) throw new Error('budget_missing');
      const budget = budgetSchema.parse(budgetRow.data);
      const spent = integer.parse(budget.spent - (prior.reserved - parsed.costMicros));
      writes.push(this.store.put(budgetKey(parsed.budgetId), { ...budget, spent }, budgetRow.rev, { limit: budget.limit, spent }, { spent: budget.spent, limit: budget.limit }));
    }
    // Result commits BEFORE B2 creates any accounts. Null cost retains reservation.
    await this.store.transact(writes);
  }
}
export function createDiscoveryReservationStore(options: ReservationOptions): DynamoDiscoveryReservationStore { return new DynamoDiscoveryReservationStore(options); }
