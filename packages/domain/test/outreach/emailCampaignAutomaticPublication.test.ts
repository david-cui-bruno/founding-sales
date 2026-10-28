import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {advanceAutomaticResearchFirm} from '../../sourcing/automaticResearch.ts';
const mocks=vi.hoisted(()=>({gate:vi.fn(),today:vi.fn(),campaign:vi.fn(),proof:vi.fn(),identity:vi.fn(),firm:vi.fn(),audit:vi.fn(),hook:vi.fn(),query:vi.fn(),events:[] as string[]}));
vi.mock('../../sourcing/automaticResearchProof.ts',()=>({automaticResearchProof:mocks.proof,automaticResearchIdentity:mocks.identity}));
vi.mock('../../sourcing/automaticResearchAuthority.ts',()=>({automaticResearchNow:async()=> '2026-10-22T22:00:00.000Z'}));
vi.mock('../../crm/firms.ts',()=>({loadFirmForUpdate:mocks.firm,createFirm:vi.fn()}));
vi.mock('../../crm/audit.ts',()=>({recordCrmAuditEvent:mocks.audit}));
vi.mock('../../policy/sendGate.ts',()=>({lockSendGateForStopFact:mocks.gate}));
vi.mock('../../today/build.ts',()=>({lockTodayForFirmChange:mocks.today}));
vi.mock('../../policy/holds.ts',()=>({listApplicableHolds:async()=>[]}));
vi.mock('../../outreach/emailCampaignAuthority.ts',()=>({lockCurrentEmailCampaign:mocks.campaign}));
vi.mock('../../outreach/emailCampaignAdmission.ts',()=>({admitAutomaticResearchRunToCampaign:mocks.hook}));
const id='00000000-0000-4000-8000-000000000001',firmId='00000000-0000-4000-8000-000000000002';
const ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),{query:mocks.query});
const proof={candidateId:id,candidateRevision:2,runId:id,owner:id,candidate:{firmName:'Example PM',website:'https://example.test/',locality:'Dallas',region:'TX'},source:{source:{kind:'search_hit',attemptId:id,sourceUrl:'https://example.test/'},originRevision:null},fingerprint:'a'.repeat(64),validUntil:'2026-10-23T22:00:00.000Z'};
beforeEach(()=>{
 vi.clearAllMocks();mocks.events.length=0;
 mocks.gate.mockImplementation(async()=>{mocks.events.push('gate');});mocks.today.mockImplementation(async()=>{mocks.events.push('today');});mocks.campaign.mockImplementation(async()=>{mocks.events.push('campaign');return null;});
 mocks.proof.mockResolvedValue(proof);mocks.identity.mockResolvedValue({firmId});mocks.firm.mockImplementation(async()=>{mocks.events.push('firm');return {id:firmId};});mocks.audit.mockResolvedValue(undefined);mocks.hook.mockImplementation(async()=>{mocks.events.push('admit');});
 mocks.query.mockImplementation(async(sql:string,values?:readonly unknown[])=>{
  const lock=sql.includes('pg_advisory_xact_lock')?values?.[0]:null;
  mocks.events.push(typeof lock==='string'&&lock.startsWith('sourcing-discovery-review:')?'lifecycle':typeof lock==='string'&&lock.startsWith('sourcing-identity:')?'identity':sql);
  if(sql.startsWith('SELECT candidate_id FROM sourcing_qualification_runs'))return {rows:[{candidate_id:id}]};
  if(sql.startsWith('INSERT INTO sourcing_automatic_research_firms'))return {rows:[{id}]};
  return {rows:[]};
 });
});
it('takes lifecycle -> gate -> Today -> identity -> campaign -> Firm -> candidate/run before the automatic admission hook',async()=>{
 await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(mocks.events.slice(0,5)).toEqual(['lifecycle','gate','today','identity','campaign']);
 expect(mocks.query.mock.calls.filter(([sql])=>String(sql).includes('pg_advisory_xact_lock')).map(([,values])=>values)).toEqual([[`sourcing-discovery-review:${id}`],[`sourcing-identity:${id}`]]);
 expect(mocks.events.indexOf('campaign')).toBeLessThan(mocks.events.indexOf('firm'));
 expect(mocks.events.findIndex(sql=>sql.startsWith('SELECT id FROM sourcing_candidates'))).toBeLessThan(mocks.events.findIndex(sql=>sql.startsWith('SELECT id FROM sourcing_qualification_runs')));
 expect(mocks.events.indexOf('firm')).toBeLessThan(mocks.events.findIndex(sql=>sql.startsWith('SELECT id FROM sourcing_candidates')));
 expect(mocks.events.slice(-2)).toEqual(['RELEASE SAVEPOINT automatic_research_publication','admit']);
 expect(mocks.hook).toHaveBeenCalledWith(ctx,id);expect(ctx.scope.actor).toEqual({kind:'system',component:'worker'});
});
it('a confirmed admission refusal conserves valid publication while no policy is approved',async()=>{
 await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(mocks.events.some(sql=>sql.startsWith('INSERT INTO sourcing_automatic_research_firms'))).toBe(true);
 expect(mocks.events.some(sql=>sql.startsWith('ROLLBACK'))).toBe(false);
});
it.each(['23503','23505','XX000'])('unknown admission failure %s is outside known publication-race refusal handling',async code=>{
 const failure=Object.assign(new Error('synthetic_unknown_admission'),{code});mocks.hook.mockRejectedValue(failure);
 await expect(advanceAutomaticResearchFirm(ctx,{runId:id})).rejects.toBe(failure);
 expect(mocks.events.at(-1)).toBe('RELEASE SAVEPOINT automatic_research_publication');
});
it('prepares ordered publication before legacy candidate revisions without admitting stale intermediate lineage',async()=>{
 await advanceAutomaticResearchFirm(ctx,{runId:id},'prepare_before_legacy');
 expect(mocks.audit).toHaveBeenCalledOnce();expect(mocks.hook).not.toHaveBeenCalled();
});
it('source proof loss rolls publication back and cannot invoke campaign admission',async()=>{
 mocks.proof.mockResolvedValueOnce(proof).mockResolvedValueOnce(proof).mockResolvedValue(null);
 await advanceAutomaticResearchFirm(ctx,{runId:id});
 expect(mocks.events.slice(-2)).toEqual(['ROLLBACK TO SAVEPOINT automatic_research_publication','RELEASE SAVEPOINT automatic_research_publication']);expect(mocks.hook).not.toHaveBeenCalled();
});
