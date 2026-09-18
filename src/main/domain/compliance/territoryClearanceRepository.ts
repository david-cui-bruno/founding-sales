import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { accountInstantSchema } from '../../../shared/contracts/accountContract';
import { confirmTerritoryClearanceSchema, isTerritoryState, revokeTerritoryClearanceSchema, TERRITORY_RULES_REVISION, TERRITORY_STATE_RULES,
  TERRITORY_STATE_TIME_ZONES, TERRITORY_STATES, territoryClearanceRecordSchema, territoryClearanceSchema, territoryClearanceSnapshotSchema, territoryReviewAt, territoryStateStatus,
  type ConfirmTerritoryClearance, type RevokeTerritoryClearance, type TerritoryClearance, type TerritoryClearanceRecord, type TerritoryClearanceSnapshot, type TerritoryStateView } from '../../../shared/contracts/territoryClearanceContract';

type Row = { state: string; revision: number; timezone: string; clearance_json: string; citation_json: string; confirmed_at: string; review_at: string; revoked_at: string | null };
const STATE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida',
  GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
});

/** Rows the authorization read needs, inside the caller's transaction. Malformed rows are dropped, never repaired: a missing clearance holds. */
export function listTerritoryClearanceRecords(database: AppDatabase): TerritoryClearanceRecord[] {
  const rows = database.raw.prepare('SELECT state,revision,timezone,confirmed_at,review_at,revoked_at FROM territory_clearances ORDER BY state').all() as Omit<Row, 'clearance_json' | 'citation_json'>[];
  return rows.flatMap(row => {
    const parsed = territoryClearanceRecordSchema.safeParse({ state: row.state, revision: row.revision, timezone: row.timezone, confirmedAt: row.confirmed_at, reviewAt: row.review_at, revokedAt: row.revoked_at });
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Per-state territory clearance storage (schema 28). A confirmation names the
 * states it covers, one or every listed state, and writes one revisioned row
 * per named state with the four statements, the rules revision and that state's
 * own citation; rows for states it does not name are never read for writing,
 * so confirming a second state later adds a row and edits nothing. A state
 * outside the current rules is refused by name and the whole request rolls
 * back. Confirming is recording the founder's attestation with a review date one
 * year out; it never dials.
 */
export class TerritoryClearanceRepository {
  constructor(private readonly deps: { database: AppDatabase; clock: Clock }) {}
  private get raw() { return this.deps.database.raw; }
  private now() { return accountInstantSchema.parse(this.deps.clock.now()); }
  private atomic<T>(run: () => T): T {
    if (this.raw.inTransaction) throw new Error('Territory clearance requires its own transaction');
    return this.raw.transaction(run).immediate();
  }
  private rows(): Map<string, TerritoryClearance> {
    const rows = this.raw.prepare('SELECT * FROM territory_clearances ORDER BY state').all() as Row[];
    const result = new Map<string, TerritoryClearance>();
    for (const row of rows) {
      let statements: unknown, citation: unknown;
      try { statements = JSON.parse(row.clearance_json); citation = JSON.parse(row.citation_json); } catch { continue; }
      const parsed = territoryClearanceSchema.safeParse({ state: row.state, revision: row.revision, timezone: row.timezone, statements, citation,
        confirmedAt: row.confirmed_at, reviewAt: row.review_at, revokedAt: row.revoked_at });
      if (parsed.success) result.set(parsed.data.state, parsed.data);
    }
    return result;
  }
  private snapshot(at: string): TerritoryClearanceSnapshot {
    const stored = this.rows();
    const view = (state: string, clearance: TerritoryClearance | null): TerritoryStateView => ({
      state: state as TerritoryStateView['state'], name: STATE_NAMES[state] ?? state,
      timezone: (isTerritoryState(state) ? TERRITORY_STATE_TIME_ZONES[state] : clearance?.timezone) as TerritoryStateView['timezone'],
      status: territoryStateStatus(clearance, at), clearance,
    });
    const territory = TERRITORY_STATES.map(state => view(state, stored.get(state) ?? null));
    const retired = [...stored.keys()].filter(state => !isTerritoryState(state)).map(state => view(state, stored.get(state)!));
    return territoryClearanceSnapshotSchema.parse({ generatedAt: at, rulesRevision: TERRITORY_RULES_REVISION, states: [...territory, ...retired] });
  }
  read(): TerritoryClearanceSnapshot { return this.snapshot(this.now()); }
  confirm(input: ConfirmTerritoryClearance): TerritoryClearanceSnapshot {
    const parsed = confirmTerritoryClearanceSchema.parse(input);
    return this.atomic(() => {
      const at = this.now(); const reviewAt = territoryReviewAt(at);
      for (const state of parsed.states) {
        if (!isTerritoryState(state)) throw new Error(`TERRITORY_STATE_NOT_LISTED:${state}`);
        const rule = TERRITORY_STATE_RULES[state];
        const statements = JSON.stringify({ businessToBusiness: true, registrationStatusChecked: true, stateDncSubscriptionChecked: true, consentRuleConfirmed: true, rulesRevision: parsed.rulesRevision });
        const citation = JSON.stringify(rule.citation);
        const existing = this.raw.prepare('SELECT revision FROM territory_clearances WHERE state=?').get(state) as { revision: number } | undefined;
        if (existing) {
          // Compare-and-set on the row's own revision: a row another writer moved on since the read is refused, never overwritten.
          const result = this.raw.prepare('UPDATE territory_clearances SET revision=?,timezone=?,clearance_json=?,citation_json=?,confirmed_at=?,review_at=?,revoked_at=NULL WHERE state=? AND revision=?')
            .run(existing.revision + 1, TERRITORY_STATE_TIME_ZONES[state], statements, citation, at, reviewAt, state, existing.revision);
          if (result.changes !== 1) throw new Error('TERRITORY_CLEARANCE_STALE');
        } else {
          this.raw.prepare('INSERT INTO territory_clearances(state,revision,timezone,clearance_json,citation_json,confirmed_at,review_at,revoked_at) VALUES(?,1,?,?,?,?,?,NULL)')
            .run(state, TERRITORY_STATE_TIME_ZONES[state], statements, citation, at, reviewAt);
        }
      }
      return this.snapshot(at);
    });
  }
  revoke(input: RevokeTerritoryClearance): TerritoryClearanceSnapshot {
    const parsed = revokeTerritoryClearanceSchema.parse(input);
    return this.atomic(() => {
      const at = this.now();
      const result = this.raw.prepare('UPDATE territory_clearances SET revision=?,revoked_at=? WHERE state=? AND revision=? AND revoked_at IS NULL')
        .run(parsed.expectedRevision + 1, at, parsed.state, parsed.expectedRevision);
      if (result.changes !== 1) throw new Error('TERRITORY_CLEARANCE_STALE');
      return this.snapshot(at);
    });
  }
}
