import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';

describe('PM account repository', () => {
  it('migrates genuine schema19 without altering people or organizations and creates no fake people/enrollment', async () => {
    const f = await createPmFixture();
    try {
      const input = { commandId: randomUUID(), name: 'Example PM', domain: 'example.invalid' };
      const account = f.repo.create(input);
      expect(account).toMatchObject({ name: input.name, domain: input.domain, version: 1 });
      expect(f.repo.create(input)).toEqual(account);
      expect(() => f.repo.create({ ...input, name: 'Changed' })).toThrow(/command/i);
      expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
      expect(f.db.raw.prepare('SELECT * FROM organizations ORDER BY id').all()).toEqual(f.historicalOrganizations);
      expect(f.db.raw.prepare('SELECT * FROM cadence_enrollments').all()).toEqual([]);
      const second = f.repo.create({ ...input, commandId: randomUUID() });
      expect(second.id).not.toBe(account.id);
      expect(f.repo.listCandidates()).toHaveLength(2);
      expect(f.repo.snapshot(account.id, PM_NOW).portfolio).toEqual([]);
      expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
    } finally { f.close(); }
  });
});

describe('B1 allocated research and outbound SQL storage', () => {
  it('binds research evidence receipts to the same account and caps attempts while preserving unknown cost', async () => {
    const f = await createPmFixture();
    try {
      const create = { commandId: randomUUID(), name: 'Example PM', domain: null as string | null };
      const a = f.repo.create(create);
      const b = f.repo.create({ ...create, commandId: randomUUID() });
      const insert = (accountId: string, attempt: number, receipt: string | null) => f.db.raw.prepare(`INSERT INTO pm_account_research_jobs
        (id,account_id,command_id,fingerprint,limits_json,state,attempt,reserved_cost_micros,cost_micros,receipt_command_id,created_at,updated_at)
        VALUES(?,?,?,?,?,'parked',?,100,NULL,?,?,?)`).run(randomUUID(), accountId, randomUUID(), 'a'.repeat(64), '{"maxPages":2}', attempt, receipt, PM_NOW, PM_NOW);
      expect(() => insert(b.id, 1, create.commandId)).toThrow();
      expect(() => insert(a.id, 4, null)).toThrow();
      insert(a.id, 1, null);
      expect(f.db.raw.prepare('SELECT cost_micros FROM pm_account_research_jobs').get()).toEqual({ cost_micros: null });
    } finally { f.close(); }
  });
});
