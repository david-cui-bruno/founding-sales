import {randomUUID} from 'node:crypto';
import type {CallToBookingFixture} from './callToBookingCases.ts';
type Fixture=CallToBookingFixture;
type Case={constraint:string;run(f:Fixture):Promise<unknown>};
async function seed(f:Fixture){
 const workspace=f.seeded.alpha.workspaceId;const owner=f.seeded.alpha.admin.userId;
 const person=(await f.session.query<{id:string}>("INSERT INTO crm_people(workspace_id,owner_user_id,full_name) VALUES($1,$2,'Original file fixture') RETURNING id",[workspace,owner])).rows[0]!.id;
 const source=(await f.session.query<{id:string}>("INSERT INTO crm_selected_sources(workspace_id,person_id,owner_user_id,source_key_hash,excerpt,content_hash) VALUES($1,$2,$3,repeat('a',64),'Original text',repeat('b',64)) RETURNING id",[workspace,person,owner])).rows[0]!.id;
 await f.session.query("INSERT INTO crm_selected_imports(workspace_id,source_id,owner_user_id,import_key_hash,input_hash,parser_version,subtype) VALUES($1,$2,$3,repeat('c',64),repeat('d',64),'selected-v1','selected_file')",[workspace,source,owner]);
 await f.session.query("INSERT INTO crm_selected_file_receipts(workspace_id,source_id,source_revision,metadata_revision,file_hash,source_content_hash,file_name,byte_length,format,parser_version,origin,state) VALUES($1,$2,1,1,repeat('e',64),repeat('b',64),'original.txt',13,'utf8_text','selected-file-utf8-v1','user_selected_original','selected')",[workspace,source]);
 return [workspace,source] as const;
}
export const SELECTED_FILE_CONSTRAINT_CASES:readonly Case[]=[
 ...[
  ['source_revision','source_revision=0'],['metadata_revision','metadata_revision=0'],
  ['file_hash',"file_hash='invalid'"],['source_content_hash',"source_content_hash='invalid'"],
  ['file_name',"file_name=''"],['byte_length','byte_length=80001'],['format',"format='pdf'"],
  ['parser_version',"parser_version='unknown'"],['origin',"origin='provider_verified'"],['state',"state='analyzed'"],
 ].map(([name,assignment])=>({constraint:`crm_selected_file_receipts_${name}_check`,run:async(f:Fixture)=>f.session.query(`UPDATE crm_selected_file_receipts SET ${assignment} WHERE workspace_id=$1 AND source_id=$2`,await seed(f))})),
 {constraint:'crm_selected_file_receipts_check',run:async f=>f.session.query('UPDATE crm_selected_file_receipts SET file_hash=NULL WHERE workspace_id=$1 AND source_id=$2',await seed(f))},
 {constraint:'crm_selected_file_receipts_pkey',run:async f=>f.session.query('INSERT INTO crm_selected_file_receipts SELECT * FROM crm_selected_file_receipts WHERE workspace_id=$1 AND source_id=$2',await seed(f))},
 {constraint:'crm_selected_file_receipts_workspace_id_source_id_fkey',run:async f=>{const [workspace,source]=await seed(f);return f.session.query('UPDATE crm_selected_file_receipts SET source_id=$3 WHERE workspace_id=$1 AND source_id=$2',[workspace,source,randomUUID()]);}},
 {constraint:'crm_selected_file_current_provenance',run:async f=>{await f.session.query('UPDATE crm_selected_file_receipts SET source_revision=2 WHERE workspace_id=$1 AND source_id=$2',await seed(f));return f.session.query('SET CONSTRAINTS crm_selected_file_current_provenance IMMEDIATE');}},
 {constraint:'crm_selected_file_current_metadata',run:async f=>{await f.session.query('SET CONSTRAINTS crm_selected_file_current_provenance IMMEDIATE');await f.session.query('UPDATE crm_selected_imports SET revision=2 WHERE workspace_id=$1 AND source_id=$2',await seed(f));return f.session.query('SET CONSTRAINTS crm_selected_file_current_metadata IMMEDIATE');}},
];
