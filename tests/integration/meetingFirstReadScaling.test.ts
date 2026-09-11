import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { TodayRepository } from '../../src/main/domain/today/todayRepository';
import { createDiscoveryDatabase, DISCOVERY_NOW, seedDiscoveryOwner, type DiscoveryDatabase } from '../fixtures/discoveryDatabase';

function fingerprint(f: DiscoveryDatabase): string {
  const raw = f.database.raw;
  raw.defaultSafeIntegers(true);
  try {
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const snapshot = tables.map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY 1`).all()]);
    return createHash('sha256').update(JSON.stringify(snapshot, (_key, value: unknown) =>
      typeof value === 'bigint' ? { bigint: value.toString() } : value)).digest('hex');
  } finally { raw.defaultSafeIntegers(false); }
}

function readOnly<T>(f: DiscoveryDatabase, read: () => T): T {
  const raw = f.database.raw;
  const before = fingerprint(f);
  const changes = raw.prepare('SELECT total_changes() AS count').get();
  raw.pragma('query_only = ON');
  try {
    const result = read();
    expect(raw.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(fingerprint(f)).toBe(before);
    return result;
  } finally { raw.pragma('query_only = OFF'); raw.defaultSafeIntegers(false); }
}

function setup(f: DiscoveryDatabase) {
  const today = new TodayRepository({ database: f.database, unitOfWork: f.services.unitOfWork });
  const domain = new FounderSalesDomain({ ...f, clock: { now: () => DISCOVERY_NOW }, ids: { next: randomUUID }, timezone: 'America/New_York' });
  return { today, transition: () => domain.transitionWorkflow({ commandId: 'scaling-transition', manifestId: 'scaling-manifest', expectedMode: 'legacy' }) };
}

function seedWarm(f: DiscoveryDatabase, prefix: string) {
  const owner = seedDiscoveryOwner(f, { prefix, units: 8 });
  f.database.raw.prepare("UPDATE prospects SET segment='warm' WHERE id=?").run(owner.prospectId);
  return owner;
}

describe('meeting-first retained read scaling', () => {
  it.each([128, 500])('materializes receipt identities once and searches membership for %i parked reviews', async count => {
    const f = await createDiscoveryDatabase();
    try {
      for (let i = 0; i < count; i++) seedWarm(f, `scale-${i}`);
      const { today, transition } = setup(f);
      expect(transition().parkedReviewActions).toHaveLength(count);
      const spy = vi.spyOn(f.database.raw, 'prepare'); // Passthrough: capture the actual production statements.
      let sql: string[];
      try {
        readOnly(f, () => {
          expect(today.listOperationalCandidates()).toEqual([]);
          expect(today.hasActiveWarm()).toBe(false);
        });
        sql = spy.mock.calls.map(([statement]) => statement).filter(statement => statement.includes('FROM workflow_transition_receipts receipt'));
      } finally { spy.mockRestore(); }
      expect(sql).toHaveLength(2);
      for (const statement of sql) {
        const plan = f.database.raw.prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as { detail: string }[];
        const details = plan.map(row => row.detail);
        expect(details.filter(detail => /MATERIALIZE parked_review_manifest/.test(detail))).toHaveLength(1);
        expect(details.some(detail => /SEARCH parked USING AUTOMATIC (?:PARTIAL )?COVERING INDEX \(action_id=\?/.test(detail))).toBe(true);
        expect(details.some(detail => /^SCAN parked$/.test(detail))).toBe(false);
      }
    } finally { f.close(); }
  });

  it('rechecks current versions on each statement and never parks future reviews', async () => {
    const f = await createDiscoveryDatabase();
    try {
      const old = seedWarm(f, 'old');
      const { today, transition } = setup(f);
      readOnly(f, () => {
        expect(today.listOperationalCandidates()).toHaveLength(1);
        expect(today.hasActiveWarm()).toBe(true);
      });
      const manifest = transition();
      readOnly(f, () => {
        expect(today.listOperationalCandidates()).toEqual([]);
        expect(today.hasActiveWarm()).toBe(false);
      });
      f.database.raw.prepare('UPDATE next_actions SET version=version+1 WHERE id=?').run(manifest.parkedReviewActions[0].id);
      readOnly(f, () => {
        expect(today.listOperationalCandidates()).toMatchObject([{ kind: 'candidate', candidate: { cycleId: old.salesCycleId } }]);
        expect(today.hasActiveWarm()).toBe(true);
      });
      const future = seedWarm(f, 'future');
      readOnly(f, () => {
        const candidates = today.listOperationalCandidates();
        expect(candidates).toHaveLength(2);
        expect(candidates).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'candidate', candidate: expect.objectContaining({ cycleId: future.salesCycleId }) })]));
        expect(today.hasActiveWarm()).toBe(true);
      });
    } finally { f.close(); }
  });

  it.each([
    ['exact', true], ['wrong-id', false], ['wrong-cycle', false],
    ['wrong-version', false], ['text-version', true], ['fractional-version', false],
    ['missing-version', false], ['wrong-mode', false],
  ] as const)('preserves SQLite identity comparison for %s receipts', async (variant, parked) => {
    const f = await createDiscoveryDatabase();
    try {
      const owner = seedWarm(f, `identity-${variant}`);
      const { today } = setup(f);
      const current = f.database.raw.prepare(`SELECT action.id, action.version FROM next_actions action
        JOIN sales_cycles cycle ON cycle.current_next_action_id=action.id WHERE cycle.id=?`).get(owner.salesCycleId) as { id: string; version: number };
      // Adversarial receipt shapes exercise comparison affinity without changing immutable receipts.
      const entry = { id: variant === 'wrong-id' ? `${current.id}-wrong` : current.id,
        cycleId: variant === 'wrong-cycle' ? `${owner.salesCycleId}-wrong` : owner.salesCycleId,
        version: variant === 'wrong-version' ? current.version + 1
          : variant === 'text-version' ? `0${current.version}`
          : variant === 'fractional-version' ? current.version + 0.5
          : variant === 'missing-version' ? undefined : current.version };
      f.database.raw.prepare(`INSERT INTO workflow_transition_receipts(command_id,manifest_id,fingerprint,result_json,created_at)
        VALUES('adversarial','adversarial',?,?,?)`).run('a'.repeat(64), JSON.stringify({
        mode: variant === 'wrong-mode' ? 'legacy' : 'meeting_first', parkedReviewActions: [entry],
      }), DISCOVERY_NOW);
      readOnly(f, () => {
        expect(today.listOperationalCandidates()).toHaveLength(parked ? 0 : 1);
        expect(today.hasActiveWarm()).toBe(!parked);
      });
    } finally { f.close(); }
  });


  it.each(['callback', 'inbound'] as const)('does not hide new %s evidence behind an existing manifest', async kind => {
    const f = await createDiscoveryDatabase();
    try {
      const owner = seedWarm(f, `later-${kind}`);
      const { today, transition } = setup(f);
      expect(transition().parkedReviewActions).toHaveLength(1);
      readOnly(f, () => {
        expect(today.listOperationalCandidates()).toEqual([]);
        expect(today.hasActiveWarm()).toBe(false);
      });
      f.database.raw.prepare(`INSERT INTO activities(id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,metadata_json,created_at,callback_at)
        VALUES(?,?,?,?,'call',?,'phone',?,'{}',?,?)`).run(`later-${kind}`, owner.personId, owner.prospectId,
        owner.salesCycleId, kind === 'callback' ? 'outbound' : 'inbound', DISCOVERY_NOW, DISCOVERY_NOW,
        kind === 'callback' ? DISCOVERY_NOW : null);
      readOnly(f, () => {
        expect(today.listOperationalCandidates()).toMatchObject([{ kind: 'candidate', candidate: { cycleId: owner.salesCycleId } }]);
        expect(today.hasActiveWarm()).toBe(true);
      });
    } finally { f.close(); }
  });


  it.each(['matching-first', 'malformed-first', 'wrong-mode', 'no-eligible', 'callback', 'inbound'] as const)(
    'matches the original-query oracle for %s malformed receipt entries', async variant => {
      const f = await createDiscoveryDatabase();
      try {
        const owner = seedWarm(f, `malformed-${variant}`);
        const { today } = setup(f);
        const current = f.database.raw.prepare(`SELECT action.id, action.version FROM next_actions action
          JOIN sales_cycles cycle ON cycle.current_next_action_id=action.id WHERE cycle.id=?`).get(owner.salesCycleId) as { id: string; version: number };
        const entry = { ...current, cycleId: owner.salesCycleId };
        if (variant === 'no-eligible') f.database.raw.prepare("UPDATE persons SET deleted_at=? WHERE id=?").run(DISCOVERY_NOW, owner.personId);
        if (variant === 'callback' || variant === 'inbound') {
          f.database.raw.prepare(`INSERT INTO activities(id,person_id,prospect_id,sales_cycle_id,kind,direction,channel,occurred_at,metadata_json,created_at,callback_at)
            VALUES('protected',?,?,?,'call',?,'phone',?,'{}',?,?)`).run(owner.personId, owner.prospectId,
            owner.salesCycleId, variant === 'callback' ? 'outbound' : 'inbound', DISCOVERY_NOW, DISCOVERY_NOW,
            variant === 'callback' ? DISCOVERY_NOW : null);
        }
        f.database.raw.prepare(`INSERT INTO workflow_transition_receipts(command_id,manifest_id,fingerprint,result_json,created_at)
          VALUES('malformed','malformed',?,?,?)`).run('b'.repeat(64), JSON.stringify({
          mode: variant === 'wrong-mode' ? 'legacy' : 'meeting_first',
          parkedReviewActions: variant === 'malformed-first' ? ['oops', entry] : [entry, 'oops'],
        }), DISCOVERY_NOW);
        for (const method of ['listOperationalCandidates', 'hasActiveWarm'] as const) {
          const spy = vi.spyOn(f.database.raw, 'prepare');
          let sql: string;
          try {
            try { today[method](); } catch { /* Capture SQL even when malformed entries throw. */ }
            sql = spy.mock.calls.map(([statement]) => statement).find(statement => statement.includes('workflow_transition_receipts'))!;
          } finally { spy.mockRestore(); }
          // The oracle is the pre-repair correlated receipt predicate, using the actual surrounding query.
          const mainSelect = method === 'hasActiveWarm' ? 'SELECT COUNT(*) AS count' : 'SELECT\n        prospect.segment';
          const outer = sql.slice(sql.indexOf(mainSelect));
          const cycle = method === 'hasActiveWarm' ? 'c' : 'cycle';
          const original = outer.replace(
            `SELECT 1 FROM parked_review_manifest parked WHERE parked.action_id=${cycle}.current_next_action_id AND parked.cycle_id=${cycle}.id`,
            `SELECT 1 FROM workflow_transition_receipts receipt, json_each(receipt.result_json,'$.parkedReviewActions') parked
    JOIN next_actions current ON current.id=${cycle}.current_next_action_id
    WHERE json_extract(receipt.result_json,'$.mode')='meeting_first'
      AND json_extract(parked.value,'$.id')=current.id
      AND json_extract(parked.value,'$.cycleId')=${cycle}.id
      AND json_extract(parked.value,'$.version')=current.version`,
          );
          expect(original).not.toContain('parked_review_manifest');
          const outcome = (read: () => unknown) => {
            try { return { result: read() }; }
            catch (error) { return { error: (error as Error).message }; }
          };
          readOnly(f, () => {
            const actual = outcome(() => today[method]());
            if (variant === 'malformed-first') expect(actual).toEqual({ error: 'malformed JSON' });
            const prepare = f.database.raw.prepare.bind(f.database.raw);
            const oracle = vi.spyOn(f.database.raw, 'prepare').mockImplementation(statement =>
              prepare(statement.includes('workflow_transition_receipts') ? original : statement));
            try {
              expect.soft(actual, `${variant}: ${method}`).toEqual(outcome(() => today[method]()));
            } finally { oracle.mockRestore(); }
          });
        }
      } finally { f.close(); }
    },
  );


  it.each(['listOperationalCandidates', 'hasActiveWarm'] as const)('does not retry unrelated SQLite errors in %s', async method => {
    const f = await createDiscoveryDatabase();
    try {
      const { today } = setup(f);
      for (const error of [
        Object.assign(new Error('unrelated SQLite failure'), { code: 'SQLITE_ERROR' }),
        Object.assign(new Error('malformed JSON'), { code: 'SQLITE_BUSY' }),
        new Error('malformed JSON'),
      ]) {
        const prepare = vi.spyOn(f.database.raw, 'prepare').mockImplementation(() => { throw error; });
        try {
          expect(() => today[method]()).toThrow(error);
          expect(prepare).toHaveBeenCalledTimes(1);
        } finally { prepare.mockRestore(); }
      }
    } finally { f.close(); }
  });

});
