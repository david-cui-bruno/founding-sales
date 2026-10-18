import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createTestDatabase,CLUSTER_URL_ENVIRONMENT_VARIABLE,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {main,MIGRATION_IDENTITY_COMMANDS} from '../src/tools/fss.ts';
import {COMMAND_DEPENDENCIES,parseFssCommand} from '../src/tools/fss/commands.ts';
let database:TestDatabase,seeded:TwoWorkspaces,url:string,allocationInput:unknown;
beforeAll(async()=>{
 database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);
 const value=new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!);value.pathname=`/${database.name}`;url=value.toString();
});
afterAll(async()=>database.drop());
async function run(argv:string[],migration=true){
 const output:string[]=[],errors:string[]=[];
 const out=vi.spyOn(process.stdout,'write').mockImplementation(value=>{output.push(String(value));return true;});
 const err=vi.spyOn(process.stderr,'write').mockImplementation(value=>{errors.push(String(value));return true;});
 try{return {code:await main(argv,migration?{FSS_MIGRATION_DATABASE_URL:url}:{DATABASE_URL:url}),stdout:output.join(''),stderr:errors.join('')};}
 finally{out.mockRestore();err.mockRestore();}
}
it('rejects removed receipt and historical schema tools before resolving database or credential dependencies',()=>{
 for(const argv of [['admin','crm-authority','provision'],['admin','crm-authority','revoke'],['admin','schema-preflight','0020'],['admin','schema-preflight','0021']])expect(parseFssCommand(argv)).toMatchObject({ok:false,reason:'command_unknown'});
 for(const name of ['crm-authority provision','crm-authority revoke','schema-preflight 0020','schema-preflight 0021']){
  expect(COMMAND_DEPENDENCIES).not.toHaveProperty(name);expect(MIGRATION_IDENTITY_COMMANDS).not.toContain(`admin ${name}`);
 }
 expect(COMMAND_DEPENDENCIES['crm-read-allocation put']).toBe('database');
});
it('records a hashed verified read allowance without authorizing capture or enqueueing history',async()=>{
 const {businessAccountBinding}=await import('@fss/domain/business/acquisition.ts');
 const mailbox=(await database.session.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'controlled-history@example.test','controlled-history-google','connected') RETURNING *",[seeded.alpha.workspaceId,seeded.alpha.admin.userId])).rows[0]!;
 const input={workspaceId:seeded.alpha.workspaceId,mailboxId:mailbox.id,ownerUserId:mailbox.owner_user_id,providerAccountId:mailbox.provider_account_id,accountBinding:businessAccountBinding(seeded.alpha.workspaceId,mailbox),generation:mailbox.generation,expectedRevision:0,projectHash:'c'.repeat(64),userHash:'d'.repeat(64),userLimitUnits:1000,projectLimitUnits:1000,userHeadroomUnits:100,projectHeadroomUnits:100,profileUnits:1,listUnits:1,historyUnits:1,metadataUnits:1,bodyUnits:1,verificationSha256:'e'.repeat(64),verifiedAt:new Date(Date.now()-1000).toISOString(),verifiedUntil:new Date(Date.now()+3600000).toISOString(),reviewedBy:seeded.alpha.admin.userId,reviewReference:'controlled independent read headroom review'};
 allocationInput=input;
 const {createHash}=await import('node:crypto');const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const argv=['admin','crm-read-allocation','put','--json-base64',Buffer.from(JSON.stringify(input)).toString('base64'),'--sha256',hash];
 const done=await run(argv);expect(done.code,done.stderr).toBe(0);expect(JSON.parse(done.stdout)).toMatchObject({revision:1,mailboxId:mailbox.id});
 expect((await database.session.query('SELECT revision,user_headroom_units FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2',[seeded.alpha.workspaceId,mailbox.id])).rows[0]).toMatchObject({revision:1,user_headroom_units:100});
 expect((await database.session.query('SELECT id FROM crm_mail_imports WHERE workspace_id=$1 AND mailbox_id=$2',[seeded.alpha.workspaceId,mailbox.id])).rows).toHaveLength(0);
 expect((await run(argv)).code).toBe(0);expect((await run(argv,false)).code).toBe(20);expect((await run([...argv.slice(0,-1),'b'.repeat(64)])).code).toBe(20);
});
it('rejects runtime allocation authority, account drift, stale edits and corrupted retry without granting reads',async()=>{
 const {crmReadAllocationSchema,provisionCrmReadAllocation,crmReadAllocationFingerprint}=await import('@fss/domain/mail/crmReadAllocation.ts');
 const value=crmReadAllocationSchema.parse(allocationInput);
 expect(await provisionCrmReadAllocation(await database.appRuntimeSession(),value)).toMatchObject({ok:false,reason:'allocation_provision_denied'});
 const encode=(input:typeof value)=>['admin','crm-read-allocation','put','--json-base64',Buffer.from(JSON.stringify(input)).toString('base64'),'--sha256',crmReadAllocationFingerprint(input)];
 expect((await run(encode({...value,userHeadroomUnits:99}))).code).toBe(20);expect((await run(encode({...value,generation:value.generation+1}))).code).toBe(20);
 await database.session.query('UPDATE crm_mail_import_allocations SET user_headroom_units=98 WHERE workspace_id=$1 AND mailbox_id=$2',[value.workspaceId,value.mailboxId]);
 expect((await run(encode(value))).code).toBe(20);
 expect((await database.session.query('SELECT id FROM crm_mail_imports WHERE workspace_id=$1 AND mailbox_id=$2',[value.workspaceId,value.mailboxId])).rows).toHaveLength(0);
});
