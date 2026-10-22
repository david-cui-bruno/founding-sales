import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../../db/workspaceScope.ts';
import {advanceAutomaticResearchFirm,readAutomaticResearchFirm} from '../../sourcing/automaticResearch.ts';
const mocks=vi.hoisted(()=>({proof:vi.fn(),identity:vi.fn(),create:vi.fn(),load:vi.fn(),audit:vi.fn(),now:vi.fn()}));
vi.mock('../../sourcing/automaticResearchProof.ts',()=>({automaticResearchProof:mocks.proof,automaticResearchIdentity:mocks.identity}));
vi.mock('../../sourcing/automaticResearchAuthority.ts',()=>({automaticResearchNow:mocks.now}));
vi.mock('../../crm/firms.ts',()=>({createFirm:mocks.create,loadFirmForUpdate:mocks.load}));
vi.mock('../../crm/audit.ts',()=>({recordCrmAuditEvent:mocks.audit}));
vi.mock('../../policy/sendGate.ts',()=>({lockSendGateForStopFact:vi.fn()}));
vi.mock('../../today/build.ts',()=>({lockTodayForFirmChange:vi.fn()}));
vi.mock('../../crm/identityAccess.ts',()=>({activeIdentityActor:vi.fn().mockResolvedValue(true)}));
const id='00000000-0000-4000-8000-000000000001',firmId='00000000-0000-4000-8000-000000000002';
const proof={candidateId:id,candidateRevision:1,runId:id,owner:id,candidate:{firmName:'Synthetic Firm',website:'https://synthetic.example.test/',locality:'Arlington',region:'TX'},source:{source:{kind:'search_hit',attemptId:id,sourceUrl:'https://synthetic.example.test/'},originRevision:null},fingerprint:'a'.repeat(64),validUntil:'2026-10-29T12:00:00.000Z'};
let holds:{scope:string;key:string;action:string}[],holdAfterAudit:boolean;
let ctx:RepositoryContext,queries:{sql:string;values:readonly unknown[]|undefined}[],prior:Record<string,unknown>|null,deleted:boolean;
beforeEach(()=>{
 vi.clearAllMocks();queries=[];prior=null;deleted=false;holds=[];holdAfterAudit=false;
 mocks.audit.mockImplementation(async()=>{if(holdAfterAudit)holds=[{scope:'firm',key:firmId,action:'research'}];});
 mocks.proof.mockResolvedValue(proof);mocks.identity.mockResolvedValue({firmId});mocks.load.mockResolvedValue({id:firmId});mocks.create.mockResolvedValue({ok:true,value:{id:firmId}});mocks.now.mockResolvedValue('2026-10-22T12:00:00.000Z');
 ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),{query:async<Row,>(sql:string,values?:readonly unknown[])=>{
  queries.push({sql,values});let rows:unknown[]=[];
  if(sql.includes('FROM active_holds'))rows=holds.filter(h=>h.action===values?.[1]&&h.key===(h.scope==='owner'?values?.[4]:values?.[2])).map(h=>({id,scope_kind:h.scope,scope_key:h.key,reason_code:'manual_pause',blocked_action_kinds:[h.action],source_event_kind:'test',source_event_id:null,owner_user_id:null,started_at:new Date('2026-10-22'),recovery_action:null}));
  else if(sql.startsWith('SELECT candidate_id FROM sourcing_qualification_runs'))rows=[{candidate_id:id}];
  else if(sql.startsWith('SELECT 1 FROM audit_events'))rows=deleted?[{exists:1}]:[];
  else if(sql.startsWith('SELECT * FROM sourcing_automatic_research_firms'))rows=prior?[prior]:[];
  else if(sql.startsWith('INSERT INTO sourcing_automatic_research_firms'))rows=[{id}];
  return {rows:rows as Row[],rowCount:rows.length};
 }});
});
it('publishes through the system owner without impersonation or campaign admission',async()=>{
 await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(queries.some(q=>q.sql.startsWith('INSERT INTO sourcing_automatic_research_firms'))).toBe(true);
 expect(mocks.audit).toHaveBeenCalledWith(ctx,expect.objectContaining({action:'sourcing.automatic_research_published'}));
 expect(queries.some(q=>q.sql.includes('ROLLBACK TO'))).toBe(false);
});
it('rolls back Firm creation and publication on final independent proof loss after waits',async()=>{
 mocks.identity.mockResolvedValueOnce({firmId:null}).mockResolvedValue({firmId});
 mocks.proof.mockResolvedValueOnce(proof).mockResolvedValueOnce(proof).mockResolvedValueOnce(null);
 await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(mocks.create).toHaveBeenCalledWith(ctx,expect.objectContaining({assignedUserId:id,researchAlreadyQualified:true}));
 expect(ctx.scope.actor).toEqual({kind:'system',component:'worker'});
 expect(queries.some(q=>q.sql==='ROLLBACK TO SAVEPOINT automatic_research_publication')).toBe(true);
});
it('does not recreate a deleted publication or Firm during committed recovery',async()=>{
 deleted=true;await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(mocks.identity).not.toHaveBeenCalled();expect(mocks.create).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
 expect(queries.some(q=>q.sql.includes('ROLLBACK TO'))).toBe(true);
});
it('replays idempotently and refreshes only changed revision-bound proof',async()=>{
 prior={id,candidate_id:id,firm_id:firmId,owner_user_id:id,source_kind:'search_hit',source_url:proof.source.source.sourceUrl,source_attempt_id:id,evidence_fingerprint:proof.fingerprint,revision:1};
 await advanceAutomaticResearchFirm(ctx,{runId:id});expect(mocks.audit).not.toHaveBeenCalled();expect(queries.some(q=>/^(INSERT|UPDATE) INTO? sourcing_automatic_research_firms/u.test(q.sql))).toBe(false);
 prior['evidence_fingerprint']='b'.repeat(64);queries=[];await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(queries.some(q=>q.sql.startsWith('UPDATE sourcing_automatic_research_firms SET run_id='))).toBe(true);expect(mocks.audit).toHaveBeenCalledOnce();
});
it('refuses a user invocation before acquiring any database lock',async()=>{
 const user=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),ctx.db);
 await advanceAutomaticResearchFirm(user,{runId:id});expect(queries).toEqual([]);
});
it.each(['23503','23505'])('rolls back a source/identity race %s without requesting a retry',async code=>{
 mocks.load.mockRejectedValueOnce({code});
 await expect(advanceAutomaticResearchFirm(ctx,{runId:id})).resolves.toBeUndefined();
 expect(queries.some(q=>q.sql==='ROLLBACK TO SAVEPOINT automatic_research_publication')).toBe(true);
});
it.each(['owner','firm'])('refuses matching %s research hold at canonical linkage and current open',async scope=>{
 holds=[{scope,key:scope==='owner'?id:firmId,action:'research'}];
 await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(mocks.load).not.toHaveBeenCalled();expect(mocks.audit).not.toHaveBeenCalled();
 expect(queries.some(q=>q.sql==='ROLLBACK TO SAVEPOINT automatic_research_publication')).toBe(true);
 prior={id,candidate_id:id,candidate_revision:1,run_id:id,firm_id:firmId,owner_user_id:id,source_kind:'search_hit',source_url:proof.source.source.sourceUrl,source_attempt_id:id,evidence_fingerprint:proof.fingerprint,revision:1};
 const user=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),ctx.db);
 expect(await readAutomaticResearchFirm(user,id)).toBeNull();
});
it('leaves unrelated owner/Firm and nonresearch holds nonblocking',async()=>{
 holds=[{scope:'owner',key:firmId,action:'research'},{scope:'firm',key:id,action:'research'},{scope:'firm',key:firmId,action:'email_send'}];
 await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(mocks.audit).toHaveBeenCalledOnce();expect(queries.some(q=>q.sql.includes('ROLLBACK TO'))).toBe(false);
});
it('rolls back new Firm and publication when exact Firm stop appears after audit wait',async()=>{
 mocks.identity.mockResolvedValueOnce({firmId:null}).mockResolvedValue({firmId});holdAfterAudit=true;
 await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(mocks.create).toHaveBeenCalledOnce();expect(mocks.audit).toHaveBeenCalledOnce();
 expect(queries.some(q=>q.sql==='ROLLBACK TO SAVEPOINT automatic_research_publication')).toBe(true);
});
it('rechecks exact owner/Firm after the current-read identity wait',async()=>{
 prior={id,candidate_id:id,candidate_revision:1,run_id:id,firm_id:firmId,owner_user_id:id,source_kind:'search_hit',source_url:proof.source.source.sourceUrl,source_attempt_id:id,evidence_fingerprint:proof.fingerprint,revision:1};
 mocks.identity.mockResolvedValueOnce({firmId}).mockImplementationOnce(async()=>{holds=[{scope:'owner',key:id,action:'research'}];return {firmId};});
 const user=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),ctx.db);
 expect(await readAutomaticResearchFirm(user,id)).toBeNull();expect(mocks.identity).toHaveBeenCalledTimes(2);
});
