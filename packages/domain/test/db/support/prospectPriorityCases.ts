import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';

type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string;admin:{userId:string}}}};
type Table='sourcing_prospect_priorities'|'sourcing_prospect_considerations';
type Row=Record<string,unknown>;
const missing='00000000-0000-4000-8000-000000000149';
const start='2026-10-20T00:00:00.000Z',end='2026-10-21T00:00:00.000Z';
const role={personId:missing,relationshipId:missing,relationshipRevision:1,role:'workflow_owner',basis:'hypothesis'};
async function row(f:Fixture,table:Table):Promise<Row>{
 const candidate=randomUUID();
 await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',
  [f.seeded.alpha.workspaceId,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);
 const common={workspace_id:f.seeded.alpha.workspaceId,candidate_id:candidate,candidate_revision:1,
  owner_user_id:f.seeded.alpha.admin.userId,fit:'unknown',value:'unknown',timing:'unknown',source_key:'a'.repeat(64),roles:'[]',expires_at:end};
 return table==='sourcing_prospect_priorities'?{...common,revision:1,source_url:'https://priority-fixture.example.test/',decided_at:start}:
  {...common,id:randomUUID(),assessment_revision:0,disposition:'considered',policy_version:'prospect-priority-v1',role_source_ids:[],role_kinds:[],occurred_at:start};
}
function insert(f:Fixture,table:Table,value:Row){
 const columns=Object.keys(value);
 return f.session.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));
}
const bad=(table:Table,constraint:string,patch:Row)=>({constraint,run:async(f:Fixture)=>insert(f,table,{...await row(f,table),...patch})});
const duplicate=(table:Table,constraint:string)=>({constraint,run:async(f:Fixture)=>{const value=await row(f,table);await insert(f,table,value);return insert(f,table,value);}});
const priority=(suffix:string,patch:Row)=>bad('sourcing_prospect_priorities',`sourcing_prospect_priorities_${suffix}`,patch);
const consideration=(suffix:string,patch:Row)=>bad('sourcing_prospect_considerations',`sourcing_prospect_considerations_${suffix}`,patch);

/** Current149 catalog only. Each case executes actual rejected DML against the
 * named CHECK/FK/primary key; historical sourcing case inventories stay frozen. */
export const PROSPECT_PRIORITY_CONSTRAINT_CASES=[
 priority('candidate_revision_check',{candidate_revision:0}),
 priority('revision_check',{revision:0}),
 priority('fit_check',{fit:'qualified'}),
 priority('value_check',{value:'negative'}),
 priority('timing_check',{timing:'likely'}),
 priority('source_url_check',{source_url:''}),
 priority('source_url_check',{source_url:'x'.repeat(2001)}),
 priority('source_key_check',{source_key:'unbound'}),
 priority('check',{expires_at:start}),
 priority('check',{expires_at:'2026-11-20T00:00:00.000Z'}),
 priority('workspace_id_candidate_id_fkey',{candidate_id:missing}),
 priority('owner_user_id_fkey',{owner_user_id:missing}),
 duplicate('sourcing_prospect_priorities','sourcing_prospect_priorities_pkey'),
 consideration('candidate_revision_check',{candidate_revision:0}),
 consideration('assessment_revision_check',{assessment_revision:-1}),
 consideration('disposition_check',{disposition:'contacted'}),
 consideration('policy_version_check',{policy_version:'qualification-v5'}),
 consideration('role_source_ids_check',{role_source_ids:Array(9).fill(missing)}),
 consideration('role_kinds_check',{role_kinds:['buyer']}),
 consideration('role_kinds_check',{role_kinds:Array(5).fill('workflow_owner')}),
 consideration('source_key_check',{source_key:'unbound'}),
 consideration('fit_check',{fit:'qualified'}),
 consideration('value_check',{value:'negative'}),
 consideration('timing_check',{timing:'likely'}),
 consideration('check',{expires_at:start}),
 consideration('check',{expires_at:'2026-11-20T00:00:00.000Z'}),
 consideration('workspace_id_candidate_id_fkey',{candidate_id:missing}),
 consideration('owner_user_id_fkey',{owner_user_id:missing}),
 duplicate('sourcing_prospect_considerations','sourcing_prospect_considerations_pkey'),
 // Both tables enforce the same closed, bounded role reference/basis shape.
 ...(['sourcing_prospect_priorities','sourcing_prospect_considerations'] as const).flatMap(table=>[
  {},Array(9).fill(role),[null],[{...role,extra:true}],[{...role,personId:'not-a-uuid'}],
  [{...role,relationshipId:'not-a-uuid'}],[{...role,relationshipRevision:0}],[{...role,relationshipRevision:1.5}],
  [{...role,role:null}],[{...role,role:'decision_maker'}],[{...role,basis:null}],[{...role,basis:'inferred_from_title'}],
 ].map(roles=>bad(table,`${table}_roles_check`,{roles:JSON.stringify(roles)}))),
];
