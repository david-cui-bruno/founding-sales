import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
it('adds real account-scoped mail checkpoint and thread-owned draft storage without invented people', async () => {
 const f=await createPmFixture();
 try {
  const account=f.repo.create({commandId:randomUUID(),name:'Mail PM',domain:null});
  expect(f.db.raw.prepare('SELECT schema_version FROM app_meta').get()).toEqual({schema_version:28});
  expect(f.db.raw.prepare('SELECT * FROM delegated_mail_cursors').all()).toEqual([]);
  expect(f.db.raw.prepare('SELECT * FROM delegated_reply_drafts').all()).toEqual([]);
  const checkpoint=f.db.raw.prepare('INSERT INTO delegated_mail_cursors VALUES(?,?,?,?,?,?)');
  expect(()=>checkpoint.run('w','missing','mail','{}',1,PM_NOW)).toThrow();
  expect(()=>checkpoint.run('w',account.id,'mail','{}',0,PM_NOW)).toThrow();
  expect(()=>checkpoint.run('w',account.id,'mail','not-json',1,PM_NOW)).toThrow();
  checkpoint.run('w',account.id,'mail','{}',1,PM_NOW);
  const draft=f.db.raw.prepare('INSERT INTO delegated_reply_drafts VALUES(?,?,?,?,?,?,?,?,?)');
  expect(()=>draft.run('w',account.id,'draft','missing-thread',1,1,'ctx','{}',PM_NOW)).toThrow();
  f.db.raw.prepare('INSERT INTO delegated_threads VALUES(?,?,?,?,?,?,?,?,?)').run('w',account.id,'thread','gmail','thread',1,'ctx','{}',PM_NOW);
  draft.run('w',account.id,'draft','thread',1,1,'ctx','{}',PM_NOW);
  expect(()=>draft.run('other-workspace',account.id,'foreign','thread',1,1,'ctx','{}',PM_NOW)).toThrow();
  expect(()=>draft.run('w',account.id,'bad-revision','thread',0,1,'ctx','{}',PM_NOW)).toThrow();
  expect(()=>draft.run('w',account.id,'bad-json','thread',1,1,'ctx','bad',PM_NOW)).toThrow();
  expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
  closeDatabase(f.db);
  const reopened=openDatabase({path:f.db.path,key:createTestWorkspaceKey()});
  try {
   expect(reopened.raw.prepare('SELECT id,thread_id,revision FROM delegated_reply_drafts').all()).toEqual([{id:'draft',thread_id:'thread',revision:1}]);
   expect(reopened.raw.prepare('SELECT revision FROM delegated_mail_cursors').all()).toEqual([{revision:1}]);
   expect(reopened.raw.pragma('foreign_key_check')).toEqual([]);
  } finally {closeDatabase(reopened);}
 } finally { f.close(); }
});
