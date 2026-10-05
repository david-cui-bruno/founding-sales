import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { saveCandidate, listCandidates, reviewCandidate, deleteCandidate } from '../../sourcing/candidates.ts';

let database: TestDatabase;
let seeded: TwoWorkspaces;
const draft = {
  firmName: 'Example PM', website: 'https://example.test/dallas/', locality: 'Dallas', region: 'TX' as const,
  signal: 'responsibility_overlap' as const, evidence: '<script>untrusted</script> Manager handles maintenance.',
  sourceUrl: 'https://example.test/team', observedOn: '2026-10-01', preparedBy: 'Manual research',
};
const context = (workspace: 'alpha' | 'beta' = 'alpha', role: 'admin' | 'salesperson' = 'admin') => {
  const who = seeded[workspace];
  return repositoryContext(workspaceScope(who.workspaceId, {kind:'user',userId:who[role].userId,role}), database.session);
};
const save = async (input = draft) => withTransaction(database.session, async () => saveCandidate(context(), input));
beforeAll(async () => { database = await createTestDatabase(); seeded = await seedTwoWorkspaces(database.session); });
beforeEach(async () => { await database.session.query('DELETE FROM sourcing_candidates'); });
afterAll(async () => { await database.drop(); });

it('stores unverified evidence without creating firms, deals or enrollments; audit contains IDs only', async () => {
  const result = await save(); expect(result.ok).toBe(true);
  const list = await listCandidates(context(), {status:'needs_review',offset:0});
  expect(list).toMatchObject({ok:true,value:{hasMore:false,candidates:[{...draft,status:'needs_review',revision:1}]}});
  for(const table of ['firms','opportunities','sequence_enrollments']) {
    const {rows} = await database.session.query(`SELECT count(*)::int AS n FROM ${table}`);
    expect(rows[0]?.['n']).toBe(0);
  }
  const audit = await database.session.query("SELECT detail FROM audit_events WHERE action='sourcing.candidate_saved'");
  expect(JSON.stringify(audit.rows)).not.toContain('untrusted');
  expect(JSON.stringify(audit.rows)).not.toContain('example.test');
});
it('deduplicates URL variants without reopening a dismissed candidate or replacing evidence', async () => {
  const first = await save(); if(!first.ok) throw new Error('save failed');
  await withTransaction(database.session, async () => reviewCandidate(context(),{id:first.value.id,expectedRevision:1,status:'dismissed'}));
  expect(await save({...draft,website:'https://www.example.test/dallas?utm_source=search',evidence:'Replacement'})).toEqual({ok:true,value:{id:first.value.id,duplicate:true}});
  expect(await listCandidates(context(),{status:'dismissed',offset:0})).toMatchObject({ok:true,value:{candidates:[{evidence:draft.evidence,revision:2}]}});
  await save({...draft,website:'https://example.test/austin/'});
  expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[{website:'https://example.test/austin/'}]}});
});
it('isolates workspaces and refuses salespeople and stale review/delete commands', async () => {
  expect(await saveCandidate(context('alpha','salesperson'),draft)).toMatchObject({ok:false,reason:'admin_only'});
  expect(await listCandidates(context('alpha','salesperson'),{status:'needs_review',offset:0})).toMatchObject({ok:false,reason:'admin_only'});
  const first = await save(); if(!first.ok) throw new Error('save failed');
  const change = {id:first.value.id,expectedRevision:1,status:'kept' as const};
  expect(await reviewCandidate(context('beta'),change)).toMatchObject({ok:false,reason:'not_found'});
  expect(await listCandidates(context('beta'),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[]}});
  await withTransaction(database.session, async () => reviewCandidate(context(),change));
  expect(await reviewCandidate(context(),change)).toMatchObject({ok:false,reason:'candidate_changed'});
  expect(await deleteCandidate(context(),change)).toMatchObject({ok:false,reason:'candidate_changed'});
  expect(await withTransaction(database.session, async () => deleteCandidate(context(),{id:first.value.id,expectedRevision:2}))).toMatchObject({ok:true});
  expect(await listCandidates(context(),{status:'kept',offset:0})).toMatchObject({ok:true,value:{candidates:[]}});
});
it('rejects invalid sources, blank evidence and future observations', async () => {
  for(const patch of [{sourceUrl:'javascript:alert(1)'},{website:'https://user:password@example.test'},{sourceUrl:'https://127.0.0.1/private'},{evidence:' '},{observedOn:'2999-01-01'}]) {
    expect(await save({...draft,...patch})).toMatchObject({ok:false,reason:'invalid_input'});
  }
});
it('paginates without a daily display cap', async () => {
  for(let i=0;i<51;i++) await save({...draft,firmName:`Candidate ${i}`});
  const first=await listCandidates(context(),{status:'needs_review',offset:0});
  const last=await listCandidates(context(),{status:'needs_review',offset:50});
  expect(first.ok && first.value.candidates.length).toBe(50);
  expect(first.ok && first.value.hasMore).toBe(true);
  expect(last.ok && last.value.candidates.length).toBe(1);
});
