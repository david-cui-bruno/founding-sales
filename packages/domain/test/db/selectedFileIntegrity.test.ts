import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import type {SessionQueryable} from '../../db/queryable.ts';

describe('selected original file database integrity',()=>{
 let database:TestDatabase;let seeded:TwoWorkspaces;let runtime:SessionQueryable;
 beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);runtime=await database.appRuntimeSession();});
 afterAll(async()=>database.drop());
 it('rejects selected-file provenance that disagrees with its current canonical source revision',async()=>{
  const workspace=seeded.alpha.workspaceId;const owner=seeded.alpha.admin.userId;
  const person=(await runtime.query<{id:string}>("INSERT INTO crm_people(workspace_id,owner_user_id,full_name) VALUES($1,$2,'File integrity fixture') RETURNING id",[workspace,owner])).rows[0]!.id;
  const source=(await runtime.query<{id:string}>("INSERT INTO crm_selected_sources(workspace_id,person_id,owner_user_id,source_key_hash,excerpt,content_hash) VALUES($1,$2,$3,repeat('a',64),'Original text',repeat('b',64)) RETURNING id",[workspace,person,owner])).rows[0]!.id;
  await runtime.query("INSERT INTO crm_selected_imports(workspace_id,source_id,owner_user_id,import_key_hash,input_hash,parser_version,subtype) VALUES($1,$2,$3,repeat('c',64),repeat('d',64),'selected-v1','selected_file')",[workspace,source,owner]);
  await expect(runtime.query("INSERT INTO crm_selected_file_receipts(workspace_id,source_id,source_revision,metadata_revision,file_hash,source_content_hash,file_name,byte_length,format,parser_version,origin,state) VALUES($1,$2,2,1,repeat('e',64),repeat('b',64),'original.txt',13,'utf8_text','selected-file-utf8-v1','user_selected_original','selected')",[workspace,source])).rejects.toMatchObject({code:'23514',constraint:'crm_selected_file_current_provenance'});
 });
 it('rejects metadata revision changes that would leave selected-file provenance bound to an older context',async()=>{
  const workspace=seeded.alpha.workspaceId;const owner=seeded.alpha.admin.userId;
  const person=(await runtime.query<{id:string}>("INSERT INTO crm_people(workspace_id,owner_user_id,full_name) VALUES($1,$2,'Metadata integrity fixture') RETURNING id",[workspace,owner])).rows[0]!.id;
  const source=(await runtime.query<{id:string}>("INSERT INTO crm_selected_sources(workspace_id,person_id,owner_user_id,source_key_hash,excerpt,content_hash) VALUES($1,$2,$3,repeat('f',64),'Original text',repeat('b',64)) RETURNING id",[workspace,person,owner])).rows[0]!.id;
  await runtime.query("INSERT INTO crm_selected_imports(workspace_id,source_id,owner_user_id,import_key_hash,input_hash,parser_version,subtype) VALUES($1,$2,$3,repeat('e',64),repeat('d',64),'selected-v1','selected_file')",[workspace,source,owner]);
  await runtime.query("INSERT INTO crm_selected_file_receipts(workspace_id,source_id,source_revision,metadata_revision,file_hash,source_content_hash,file_name,byte_length,format,parser_version,origin,state) VALUES($1,$2,1,1,repeat('e',64),repeat('b',64),'original.txt',13,'utf8_text','selected-file-utf8-v1','user_selected_original','selected')",[workspace,source]);
  await expect(runtime.query('UPDATE crm_selected_imports SET revision=2 WHERE workspace_id=$1 AND source_id=$2',[workspace,source])).rejects.toMatchObject({code:'23514',constraint:'crm_selected_file_current_metadata'});
 });

});
