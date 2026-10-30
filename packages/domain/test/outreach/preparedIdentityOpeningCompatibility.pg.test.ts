import {expect,it} from 'vitest';
import {campaignOpeningPgFixture} from './campaignOpeningPgFixture.ts';
import {readCurrentCampaignOpening} from '../../outreach/campaignOpeningSource.ts';
import {repositoryContext} from '../../db/workspaceScope.ts';
import type {SessionQueryable,QueryResultRowLike} from '../../db/queryable.ts';

it('preserves the actual legacy discovery opening fingerprint across additive151 producer metadata without selection or dispatch',async()=>{
 const f=await campaignOpeningPgFixture();
 try{
  let projected=0;
  const pre151:SessionQueryable={query:async<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{
   const result=await f.db.query<Row>(sql,values);
   if(sql.startsWith('SELECT * FROM sourcing_qualification_runs')){
    projected++;
    // Only the two additive metadata fields are omitted to model the actual
    // pre151 SELECT * row; every existing typed column keeps its stored value.
    return {...result,rows:result.rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['producer_version','prepared_identity'].includes(key))) as Row)};
   }
   return result;
  }};
  const legacy=await readCurrentCampaignOpening(repositoryContext(f.worker.scope,pre151),f.executionId);
  const migrated=await readCurrentCampaignOpening(f.worker,f.executionId);
  expect(projected).toBe(1);expect(legacy.kind).toBe('current');expect(migrated.kind).toBe('current');
  if(legacy.kind!=='current'||migrated.kind!=='current')throw Error('Current legacy opening is required for the compatibility comparison');
  expect(migrated.snapshot.binding.sourceFingerprint).toBe(legacy.snapshot.binding.sourceFingerprint);
  expect((await f.db.query('SELECT producer_version,prepared_identity FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[f.w,f.source.selection.runId])).rows).toEqual([{producer_version:'qualification-context-v7',prepared_identity:null}]);
  expect((await f.db.query('SELECT 1 FROM outreach_campaign_opening_attempts WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0);
  expect((await f.db.query('SELECT 1 FROM outbound_messages WHERE workspace_id=$1',[f.w])).rows).toHaveLength(0);
 }finally{await f.stop();}
});
