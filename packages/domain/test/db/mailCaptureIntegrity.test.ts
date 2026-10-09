import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../db/testing/testDatabase.ts';
import { seedTwoWorkspaces } from './support/fixtures.ts';
import { seedCrm } from './support/crmFixtures.ts';
import { seedMail } from './support/mailFixtures.ts';
import { seedMailCaptureCatalogFixture } from './support/mailCaptureCases.ts';

// The database integrity seam: deferred constraints must conserve an available
// canonical source across independent runtime transactions, not just one session.
describe('available copied mail canonical integrity', () => {
  it('serializes canonical removal against a newly committed available source', async () => {
    const database = await createTestDatabase();
    const writer = await database.appRuntimeSession();
    const remover = await database.appRuntimeSession();
    try {
      const seeded = await seedTwoWorkspaces(database.session);
      const crm = await seedCrm(database.session, seeded);
      const mail = await seedMail(database.session, seeded, crm);
      await seedMailCaptureCatalogFixture({ session: database.session, seeded, crm, mail });
      const values = [seeded.alpha.workspaceId, mail.alpha.messageId];
      const fixture = await database.session.query<{ snapshot: unknown }>(
        'DELETE FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2 RETURNING to_jsonb(crm_mail_sources) AS snapshot', values,
      );
      await writer.query('BEGIN');
      await writer.query('INSERT INTO crm_mail_sources SELECT (jsonb_populate_record(NULL::crm_mail_sources,$1::jsonb)).*', [JSON.stringify(fixture.rows[0]?.snapshot)]);
      await writer.query('SET CONSTRAINTS ALL IMMEDIATE');
      await remover.query('BEGIN');
      const pid = (await remover.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      const removal = remover.query('DELETE FROM mail_messages WHERE workspace_id=$1 AND id=$2', values);
      // A control connection observes the real row-lock wait before releasing A.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const row = await database.session.query<{ blocked: boolean }>('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid]);
        if (row.rows[0]?.blocked) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query('COMMIT');
      await removal;
      await expect(remover.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({ code: '23503', constraint: 'crm_mail_available_source_canonical' });
      await remover.query('ROLLBACK');
      const retained = await database.session.query<{ count: string }>(
        "SELECT count(*) AS count FROM crm_mail_sources s JOIN mail_messages m ON m.workspace_id=s.workspace_id AND m.id=s.source_id WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.availability='available'", values,
      );
      expect(retained.rows[0]?.count).toBe('1');
    } finally {
      await writer.query('ROLLBACK');
      await remover.query('ROLLBACK');
      await database.drop();
    }
  });
});
