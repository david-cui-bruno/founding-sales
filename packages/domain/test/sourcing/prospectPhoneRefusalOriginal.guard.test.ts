import {afterEach,expect,it,vi} from 'vitest';
import config,{phoneRefusalOriginalPgDeferredLocally,requirePhoneRefusalOriginalPgAuthority} from '../../vitest.phoneRefusalOriginal.pg.config.ts';
const service='postgresql://postgres@127.0.0.1:5432/postgres';
const hosted=():NodeJS.ProcessEnv=>({CI:'true',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_JOB:'greenfield',FSS_TEST_REQUIRE_PGVECTOR:'1',FSS_TEST_POSTGRES_URL:service,FSS_TEST_CLUSTER_URL:service,FSS_TEST_TEMPLATE_DATABASE:`fss_template_${'a'.repeat(32)}`});
afterEach(()=>vi.unstubAllEnvs());
it('retained PG guard admits explicit local grant, but CI or service variables alone cannot replace it',()=>{
 expect(()=>requirePhoneRefusalOriginalPgAuthority({FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT:'retained-only'},'darwin')).not.toThrow();
 for(const env of [{},{CI:'true'},{FSS_TEST_POSTGRES_URL:service},{FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT:'wrong'},hosted()])expect(()=>requirePhoneRefusalOriginalPgAuthority(env,'darwin')).toThrow('Fresh Root');
});
it('retained PG guard admits canonical hosted service after matching canonical globalSetup, without mutating its environment',()=>{
 const env=hosted(),before={...env};expect(()=>requirePhoneRefusalOriginalPgAuthority(env,'linux')).not.toThrow();expect(env).toEqual(before);
});
it.each(['CI','GITHUB_ACTIONS','RUNNER_ENVIRONMENT','RUNNER_OS','GITHUB_JOB','FSS_TEST_REQUIRE_PGVECTOR','FSS_TEST_POSTGRES_URL','FSS_TEST_CLUSTER_URL','FSS_TEST_TEMPLATE_DATABASE'])('retained PG guard refuses incomplete hosted authority: %s',key=>{
 const env=hosted();delete env[key];expect(()=>requirePhoneRefusalOriginalPgAuthority(env,'linux')).toThrow('Fresh Root');
});
it.each(['not-a-url','postgresql://postgres@production.example.test:5432/postgres','postgresql://postgres@127.0.0.1:5433/postgres','postgresql://postgres@127.0.0.1:5432/live'])('retained PG guard refuses a noncanonical service destination',url=>{
 const env={...hosted(),FSS_TEST_POSTGRES_URL:url,FSS_TEST_CLUSTER_URL:url};expect(()=>requirePhoneRefusalOriginalPgAuthority(env,'linux')).toThrow('Fresh Root');
});
it.each([{FSS_TEST_CLUSTER_URL:`${service}?different=1`},{FSS_TEST_TEMPLATE_DATABASE:'not-a-canonical-template'},{RUNNER_ENVIRONMENT:'self-hosted'}])('retained PG guard refuses mismatched setup or runner authority',change=>{
 expect(()=>requirePhoneRefusalOriginalPgAuthority({...hosted(),...change},'linux')).toThrow('Fresh Root');
});
it('retained isolated config still refuses before globalSetup without local grant, including hosted-looking variables',async()=>{
 for(const [key,value] of Object.entries(hosted()))vi.stubEnv(key,value);
 vi.stubEnv('FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT',undefined);
 if(typeof config!=='function')throw Error('Expected lazy guarded configuration');
 expect(()=>config({command:'serve',mode:'test'})).toThrow('Fresh Root');
 vi.stubEnv('FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT','retained-only');
 expect(await config({command:'serve',mode:'test'})).toMatchObject({test:{include:['test/sourcing/prospectPhoneRefusalOriginal.pg.test.ts'],globalSetup:['db/testing/globalSetup.ts'],maxWorkers:1}});
});
it('general local runs defer the PG suite without a grant, but hosted-looking runs and granted runs do not',()=>{
 expect(phoneRefusalOriginalPgDeferredLocally({},'darwin')).toBe(true);
 expect(phoneRefusalOriginalPgDeferredLocally({FSS_TEST_POSTGRES_URL:service},'darwin')).toBe(true);
 expect(phoneRefusalOriginalPgDeferredLocally({FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT:'retained-only'},'darwin')).toBe(false);
 expect(phoneRefusalOriginalPgDeferredLocally({CI:'true'},'darwin')).toBe(true);
 expect(phoneRefusalOriginalPgDeferredLocally({GITHUB_ACTIONS:'true'},'linux')).toBe(false);
 expect(phoneRefusalOriginalPgDeferredLocally({...hosted(),GITHUB_JOB:'other'},'linux')).toBe(false);
 expect(phoneRefusalOriginalPgDeferredLocally(hosted(),'linux')).toBe(false);
});
