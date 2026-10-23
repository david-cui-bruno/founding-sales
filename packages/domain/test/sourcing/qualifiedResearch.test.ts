import {expect,it,vi} from 'vitest';
import {researchFingerprint} from '../../sourcing/qualifiedResearchProof.ts';
import {createQualifiedResearchFirm} from '../../sourcing/qualifiedResearch.ts';
import type {RepositoryContext} from '../../db/workspaceScope.ts';
vi.mock('../../crm/identityAccess.ts',()=>({activeIdentityActor:vi.fn(async()=>true)}));
vi.mock('../../policy/sendGate.ts',()=>({lockSendGateForStopFact:vi.fn(async()=>undefined)}));
vi.mock('../../today/build.ts',()=>({lockTodayForFirmChange:vi.fn(async()=>undefined),refreshTodayForFirm:vi.fn(async()=>undefined)}));
it('fingerprint is deterministic over object order and binds retained blocks, facts and revisions',()=>{
 const a={revision:1,facts:[{value:'source'}],observations:[{contentHash:'a',blocks:[{text:'retained'}]}]};
 expect(researchFingerprint(a)).toBe(researchFingerprint({observations:a.observations,facts:a.facts,revision:1}));
 for(const b of [{...a,revision:2},{...a,facts:[{value:'changed'}]},{...a,observations:[{contentHash:'a',blocks:[{text:'changed'}]}]}])expect(researchFingerprint(b)).not.toBe(researchFingerprint(a));
});
it('rolls back the whole savepoint on unavailable current qualification and stores no content',async()=>{
 const queries:string[]=[];
 const db={query:vi.fn(async(sql:string)=>{queries.push(sql);return {rows:[],rowCount:0};})};
 const ctx={db,scope:{workspaceId:'00000000-0000-4000-8000-000000000001',actor:{kind:'user',role:'admin',userId:'00000000-0000-4000-8000-000000000002'}}} as unknown as RepositoryContext;
 const id='00000000-0000-4000-8000-000000000003';
 expect(await createQualifiedResearchFirm(ctx,{discoveryCandidateId:id,discoveryRevision:1,candidateId:id,candidateRevision:1,runId:id})).toEqual({ok:false,reason:'qualification_changed'});
 expect(queries).toContain('ROLLBACK TO SAVEPOINT qualified_research_firm');
 expect(queries.at(-1)).toBe('RELEASE SAVEPOINT qualified_research_firm');
 expect(queries.some(sql=>/INSERT/u.test(sql))).toBe(false);
});
it('checks current API authority after lock waits and rolls back before creating a Firm',async()=>{
 const queries:string[]=[];
 const ctx={db:{query:async(sql:string)=>{queries.push(sql);return {rows:[]};}},scope:{workspaceId:'workspace',actor:{kind:'user',role:'admin',userId:'owner'}}} as unknown as RepositoryContext;
 const id='00000000-0000-4000-8000-000000000003';
 const currentAuthority=vi.fn(async()=>false);
 expect(await createQualifiedResearchFirm(ctx,{discoveryCandidateId:id,discoveryRevision:1,candidateId:id,candidateRevision:1,runId:id},currentAuthority)).toEqual({ok:false,reason:'authority_changed'});
 expect(currentAuthority).toHaveBeenCalledOnce();
 expect(queries).toContain('ROLLBACK TO SAVEPOINT qualified_research_firm');
 expect(queries.some(sql=>/INSERT/u.test(sql))).toBe(false);
});
