import pg from 'pg';
import {readToolConfig} from './config.ts';
/** No runtime fallback, DDL, credential values or database error messages leave this check. */
export async function migrationAuthenticationCheck(options:Readonly<Record<string,string>>,environment:Readonly<Record<string,string|undefined>>) {
 const checkedAt=new Date().toISOString();
 let client:pg.Client|null=null;
 try {
  const config=readToolConfig({...environment,DATABASE_URL:undefined,DATABASE_SECRET_ARN:undefined},{runtimeConnection:'optional'});
  if(!config.migrationDatabase)return {ok:false,checkedAt,reason:'migration_credential_missing'};
  if(new URL(config.migrationDatabase.connectionString).hostname!==options['--expected-host'])return {ok:false,checkedAt,reason:'migration_binding_mismatch'};
  client=new pg.Client({connectionString:config.migrationDatabase.connectionString,connectionTimeoutMillis:10_000,query_timeout:10_000,application_name:'fss-migration-auth-check'});
  await client.connect();
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='10s'");
  const identity=(await client.query<{database:string;identity:string;read_only:string}>("SELECT current_database() AS database,current_user AS identity,current_setting('transaction_read_only') AS read_only")).rows[0]!;
  if(identity.database!==options['--expected-database']||identity.identity!==options['--expected-user'])return {ok:false,checkedAt,reason:'migration_binding_mismatch'};
  const role=(await client.query<{member:boolean}>("SELECT pg_has_role(current_user,'migration','USAGE') AS member")).rows[0]!;
  if(!role.member||identity.read_only!=='on')return {ok:false,checkedAt,reason:'migration_identity_refused'};
  const schema=(await client.query<{version:number}>("SELECT max(version)::int AS version FROM schema_versions")).rows[0]!;
  await client.query('ROLLBACK');
  return {ok:true,checkedAt,database:identity.database,identity:identity.identity,schemaVersion:schema.version,readOnly:identity.read_only==='on',migrationMember:role.member};
 }catch(error){
  const code=(error as {code?:unknown}).code;
  return {ok:false,checkedAt,reason:code==='28P01'?'authentication_failed':error instanceof Error&&/timeout|timed out/iu.test(error.message)?'connection_timeout':'connection_refused'};
 }finally{if(client)await client.end().catch(()=>undefined);}
}
