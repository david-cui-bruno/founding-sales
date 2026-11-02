import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';

type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
type Row=Record<string,unknown>;
const missing='00000000-0000-4000-8000-000000000160';
async function row(f:Fixture,state:'found'|'reserved'='found'):Promise<Row>{
 const candidate=randomUUID();
 await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.seeded.alpha.workspaceId,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);
 const base:Row={workspace_id:f.seeded.alpha.workspaceId,candidate_id:candidate,candidate_revision:1,host:`${candidate.slice(0,8)}.example.test`,provider:'apollo',state,credits:1,business_date:'2026-11-02',business_time_zone:'America/New_York',reserved_at:'2026-11-02T12:00:00.000Z',expires_at:'2026-12-02T12:00:00.000Z'};
 return state==='reserved'?base:{...base,provider_person_id:'p1',first_name:'Jordan',last_name:'Blake',title:'Owner',email:`jordan@${base['host'] as string}`,email_status:'verified',match_confidence:'high',observed_at:'2026-11-02T12:00:00.000Z'};
}
function insert(f:Fixture,value:Row){
 const columns=Object.keys(value);
 return f.session.query(`INSERT INTO outreach_people_contacts(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));
}
const bad=(constraint:string,patch:Row,state:'found'|'reserved'='found')=>({constraint:`outreach_people_contacts_${constraint}`,run:async(f:Fixture)=>insert(f,{...await row(f,state),...patch})});

/** Current160 catalog only. Each case executes actual rejected DML against the named CHECK/FK/UNIQUE/primary key. */
export const PEOPLE_CONTACT_CONSTRAINT_CASES=[
 bad('revision',{candidate_revision:0},'reserved'),
 bad('host',{host:''},'reserved'),bad('host',{host:'Mixed.Example.Test'},'reserved'),
 bad('provider',{provider:'Apollo'},'reserved'),
 bad('state',{state:'maybe'},'reserved'),
 bad('reason',{reason:'because'},'reserved'),
 bad('credits',{credits:10},'reserved'),
 bad('zone',{business_time_zone:''},'reserved'),
 bad('expiry',{expires_at:'2026-11-02T12:00:00.000Z'},'reserved'),bad('expiry',{expires_at:'2026-12-04T12:00:00.000Z'},'reserved'),
 bad('found',{email_status:'unverified'}),bad('found',{match_confidence:'low'}),bad('found',{email:'jordan@other.example.test'}),bad('found',{first_name:null}),
 bad('found',{email:'someone@example.test'},'reserved'),
 bad('candidate_fkey',{candidate_id:missing},'reserved'),
 {constraint:'outreach_people_contacts_pkey',run:async(f:Fixture)=>{const value={...await row(f,'reserved'),id:randomUUID()};await insert(f,value);return insert(f,{...await row(f,'reserved'),id:value['id']});}},
 {constraint:'outreach_people_contacts_candidate_provider_key',run:async(f:Fixture)=>{const value=await row(f,'reserved');await insert(f,value);return insert(f,{...value,host:`other-${value['host'] as string}`});}},
 {constraint:'outreach_people_contacts_host_provider_key',run:async(f:Fixture)=>{const value=await row(f,'reserved'),second=await row(f,'reserved');await insert(f,value);return insert(f,{...second,host:value['host']});}},
];
