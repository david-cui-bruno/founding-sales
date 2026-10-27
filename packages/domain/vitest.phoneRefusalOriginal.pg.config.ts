import {defineConfig} from 'vitest/config';

/** Hosted canonical greenfield owns its service allocation. Local runs still need
 * the explicit grant, including when CI-looking variables are inherited. */
export function requirePhoneRefusalOriginalPgAuthority(env:NodeJS.ProcessEnv=process.env,platform:NodeJS.Platform=process.platform):void{
 if(env['FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT']==='retained-only')return;
 const service=env['FSS_TEST_POSTGRES_URL']?.trim();
 if(platform==='linux'&&env['CI']==='true'&&env['GITHUB_ACTIONS']==='true'&&env['RUNNER_ENVIRONMENT']==='github-hosted'&&env['RUNNER_OS']==='Linux'&&env['GITHUB_JOB']==='greenfield'&&env['FSS_TEST_REQUIRE_PGVECTOR']==='1'&&service&&env['FSS_TEST_CLUSTER_URL']===service&&/^fss_template_[a-f0-9]{32}$/u.test(env['FSS_TEST_TEMPLATE_DATABASE']??'')){
  try{
   const url=new URL(service);
   if(url.protocol==='postgresql:'&&url.hostname==='127.0.0.1'&&url.port==='5432'&&url.pathname==='/postgres'&&url.username==='postgres'&&!url.search&&!url.hash)return;
  }catch{ /* Malformed or noncanonical service authority cannot replace a local grant. */ }
 }
 throw Error('Fresh Root exclusive PG grant required outside canonical hosted greenfield');
}

// This isolated local entrypoint remains stricter than the hosted canonical suite.
// Vitest evaluates the factory before it can invoke globalSetup or allocate PG.
export default defineConfig(()=>{
 if(process.env['FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT']!=='retained-only')throw Error('Fresh Root exclusive retained-original PG grant required before globalSetup');
 return {test:{include:['test/sourcing/prospectPhoneRefusalOriginal.pg.test.ts'],globalSetup:['db/testing/globalSetup.ts'],maxWorkers:1,testTimeout:30000,hookTimeout:60000}};
});
