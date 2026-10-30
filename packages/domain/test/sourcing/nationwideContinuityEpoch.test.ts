import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../../db/workspaceScope.ts';
import {advanceAutomaticResearchFirm,readAutomaticResearchFirm} from '../../sourcing/automaticResearch.ts';
const m=vi.hoisted(()=>({proof:vi.fn(),identity:vi.fn(),audit:vi.fn()}));
vi.mock('../../sourcing/automaticResearchProof.ts',()=>({automaticResearchProof:m.proof,automaticResearchIdentity:m.identity}));
vi.mock('../../sourcing/automaticResearchAuthority.ts',()=>({automaticResearchOwner:async()=>id,automaticResearchNow:async()=> '2026-10-22T12:00:00.000Z'}));
vi.mock('../../crm/firms.ts',()=>({loadFirmForUpdate:async()=>({id}),createFirm:vi.fn()}));
vi.mock('../../crm/audit.ts',()=>({recordCrmAuditEvent:m.audit}));
vi.mock('../../policy/sendGate.ts',()=>({lockSendGateForStopFact:vi.fn()}));
vi.mock('../../today/build.ts',()=>({lockTodayForFirmChange:vi.fn()}));
vi.mock('../../crm/identityAccess.ts',()=>({activeIdentityActor:async()=>true}));
const id='00000000-0000-4000-8000-000000000001';
const proof={targetingVersion:'targeting-old',nativePolicyVersion:'native-firm-eligibility-v1',candidateId:id,candidateRevision:1,runId:id,owner:id,
 candidate:{firmName:'Synthetic Firm',website:'https://synthetic.example.test/',locality:'Arlington',region:'TX'},
 source:{source:{kind:'search_hit',attemptId:id,sourceUrl:'https://synthetic.example.test/'},originRevision:null},fingerprint:'a'.repeat(64),validUntil:'2026-10-29T12:00:00.000Z'};
let ctx:RepositoryContext,sqls:string[];
beforeEach(()=>{
 vi.clearAllMocks();m.proof.mockReset();m.proof.mockResolvedValue(proof);m.identity.mockResolvedValue({firmId:id});sqls=[];
 ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),{query:async<Row,>(sql:string)=>{
  sqls.push(sql);let rows:unknown[]=[];
  if(sql.startsWith('SELECT candidate_id FROM sourcing_qualification_runs'))rows=[{candidate_id:id}];
  if(sql.startsWith('INSERT INTO sourcing_automatic_research_firms'))rows=[{id}];
  if(sql==='SELECT * FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND id=$2')rows=[{id,candidate_id:id,candidate_revision:1,run_id:id,firm_id:id,owner_user_id:id,source_kind:'search_hit',source_url:proof.source.source.sourceUrl,source_attempt_id:id,evidence_fingerprint:proof.fingerprint,native_policy_version:proof.nativePolicyVersion,revision:1}];
  return {rows:rows as Row[],rowCount:rows.length};
 }});
});
it.each(['current','final'] as const)('refuses an in-flight %s epoch change even when every persisted fingerprint byte remains equal',async stage=>{
 m.proof.mockResolvedValueOnce(proof);
 if(stage==='final')m.proof.mockResolvedValueOnce(proof);
 m.proof.mockResolvedValue({...proof,targetingVersion:'targeting-new'});
 await advanceAutomaticResearchFirm(ctx,{runId:id},'prepare_before_legacy');
 expect(sqls).toContain('ROLLBACK TO SAVEPOINT automatic_research_publication');
 expect(m.audit).toHaveBeenCalledTimes(stage==='final'?1:0);
});
it('refuses a fresh current read across an epoch change despite equal persisted proof',async()=>{
 m.proof.mockResolvedValueOnce(proof).mockResolvedValue({...proof,targetingVersion:'targeting-new'});
 const user=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),ctx.db);
 expect(await readAutomaticResearchFirm(user,id)).toBeNull();expect(m.identity).toHaveBeenCalledOnce();
});
it('publishes an unchanged proof when the entire operation starts and finishes in a later epoch',async()=>{
 m.proof.mockResolvedValue({...proof,targetingVersion:'targeting-new'});
 await advanceAutomaticResearchFirm(ctx,{runId:id},'prepare_before_legacy');
 expect(sqls).not.toContain('ROLLBACK TO SAVEPOINT automatic_research_publication');expect(m.audit).toHaveBeenCalledOnce();
});
