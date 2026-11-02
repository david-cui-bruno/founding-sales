import {randomUUID} from 'node:crypto';
import type {SessionQueryable} from '../../../db/queryable.ts';

type Fixture={session:SessionQueryable;seeded:{alpha:{workspaceId:string}}};
type Row=Record<string,unknown>;
const missing='00000000-0000-4000-8000-000000000160';
const insertInto=(f:Fixture,table:string,value:Row)=>{const columns=Object.keys(value);return f.session.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(value));};
/** A spend-custody row for a real candidate: 'reserved' holds no result, 'found' and 'none' carry an observation. */
async function lookup(f:Fixture,state:'found'|'reserved'|'none'='reserved'):Promise<Row>{
 const candidate=randomUUID();
 await f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.seeded.alpha.workspaceId,candidate,candidate.replaceAll('-','').padEnd(64,'0'),'{}']);
 const base:Row={workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),candidate_id:candidate,candidate_revision:1,host:`${candidate.slice(0,8)}.example.test`,provider:'apollo',state,credits:1,business_date:'2026-11-02',business_time_zone:'America/New_York',reserved_at:'2026-11-02T12:00:00.000Z',expires_at:'2026-12-02T12:00:00.000Z'};
 return state==='reserved'?base:{...base,observed_at:'2026-11-02T12:00:00.000Z'};
}
/** A paid single-address check row (ADR0038): no foreign key to the candidate, so any opaque id; 'none' carries the verifier's verdict as its reason and an observation. */
const paidCheck=(f:Fixture):Row=>{const candidate=randomUUID();return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),candidate_id:candidate,candidate_revision:1,host:`${candidate.slice(0,8)}.example.test`,kind:'guess',state:'none',reason:'verdict_ok',credits:1,business_date:'2026-11-02',business_time_zone:'America/New_York',reserved_at:'2026-11-02T12:00:00.000Z',observed_at:'2026-11-02T12:00:00.000Z',expires_at:'2026-12-02T12:00:00.000Z'};};
const badPaid=(constraint:string,patch:Row)=>({constraint:`outreach_people_paid_checks_${constraint}`,run:async(f:Fixture)=>insertInto(f,'outreach_people_paid_checks',{...paidCheck(f),...patch})});
const badLookup=(constraint:string,patch:Row,state:'found'|'reserved'|'none'='reserved')=>({constraint:`outreach_people_lookups_${constraint}`,run:async(f:Fixture)=>insertInto(f,'outreach_people_lookups',{...await lookup(f,state),...patch})});
/** A found lookup plus a person copy for it; `patch` changes the person. */
async function person(f:Fixture,patch:Row={}):Promise<Row>{
 const found=await lookup(f,'found');await insertInto(f,'outreach_people_lookups',found);
 return {workspace_id:found['workspace_id'],lookup_id:found['id'],candidate_id:found['candidate_id'],host:found['host'],provider_person_id:'p1',first_name:'Jordan',last_name:'Blake',title:'Owner',email:`jordan@${found['host'] as string}`,email_status:'verified',match_confidence:'high',...patch};
}
const badPerson=(constraint:string,patch:Row)=>({constraint:`outreach_people_contacts_${constraint}`,run:async(f:Fixture)=>insertInto(f,'outreach_people_contacts',await person(f,patch))});

/** Current162 catalog only (0161 widens the 0160 person CHECK and adds the citation CHECK; 0162 adds `verified_guess` to the person CHECK and the verdict reasons to the custody CHECK). Each case executes actual rejected DML against the named CHECK/FK/UNIQUE/primary key. */
export const PEOPLE_CONTACT_CONSTRAINT_CASES=[
 badLookup('revision',{candidate_revision:0}),
 badLookup('host',{host:''}),badLookup('host',{host:'Mixed.Example.Test'}),
 badLookup('provider',{provider:'Apollo'}),
 badLookup('state',{state:'maybe'}),
 badLookup('reason',{reason:'because'}),badLookup('reason',{reason:'verdict_maybe'}),badLookup('reason',{reason:'guess_invalid'}),
 badLookup('credits',{credits:10}),
 badLookup('zone',{business_time_zone:''}),
 badLookup('expiry',{expires_at:'2026-11-02T12:00:00.000Z'}),badLookup('expiry',{expires_at:'2026-12-04T12:00:00.000Z'}),
 badLookup('shape',{observed_at:null},'found'),badLookup('shape',{observed_at:null},'none'),badLookup('shape',{observed_at:'2026-11-02T12:00:00.000Z'}),badLookup('shape',{reason:'no_person'},'found'),
 {constraint:'outreach_people_lookups_pkey',run:async(f:Fixture)=>{const value=await lookup(f);await insertInto(f,'outreach_people_lookups',value);return insertInto(f,'outreach_people_lookups',{...await lookup(f),id:value['id']});}},
 {constraint:'outreach_people_lookups_candidate_provider_key',run:async(f:Fixture)=>{const value=await lookup(f);await insertInto(f,'outreach_people_lookups',value);return insertInto(f,'outreach_people_lookups',{...value,id:randomUUID(),host:`other-${value['host'] as string}`});}},
 {constraint:'outreach_people_lookups_host_provider_key',run:async(f:Fixture)=>{const value=await lookup(f),second=await lookup(f);await insertInto(f,'outreach_people_lookups',value);return insertInto(f,'outreach_people_lookups',{...second,host:value['host']});}},
 badPaid('revision',{candidate_revision:0}),badPaid('host',{host:''}),badPaid('host',{host:'Mixed.Example.Test'}),badPaid('kind',{kind:'other'}),badPaid('state',{state:'maybe',observed_at:null}),
 badPaid('reason',{reason:'because'}),badPaid('reason',{reason:'verdict_maybe'}),badPaid('reason',{reason:'no_person'}),badPaid('credits',{credits:2}),badPaid('zone',{business_time_zone:''}),
 badPaid('expiry',{expires_at:'2026-11-02T12:00:00.000Z'}),badPaid('expiry',{expires_at:'2026-12-04T12:00:00.000Z'}),
 badPaid('shape',{observed_at:null}),badPaid('shape',{reason:null}),badPaid('shape',{state:'reserved',observed_at:null}),badPaid('shape',{state:'failed',observed_at:null,reason:null}),badPaid('shape',{state:'unknown',observed_at:'2026-11-02T12:00:00.000Z'}),
 {constraint:'outreach_people_paid_checks_pkey',run:async(f:Fixture)=>{const value=paidCheck(f);await insertInto(f,'outreach_people_paid_checks',value);return insertInto(f,'outreach_people_paid_checks',{...paidCheck(f),id:value['id']});}},
 {constraint:'outreach_people_paid_checks_revision_key',run:async(f:Fixture)=>{const value=paidCheck(f);await insertInto(f,'outreach_people_paid_checks',value);return insertInto(f,'outreach_people_paid_checks',{...value,id:randomUUID(),host:`other-${value['host'] as string}`});}},
 badPerson('found',{email_status:'unverified'}),badPerson('found',{email_status:'published'}),badPerson('found',{email:null}),badPerson('found',{email:null,email_status:'published',source_url:'https://x.example/',source_block_id:'b1',source_quote:'q'}),badPerson('found',{email_status:'unavailable'}),
 badPerson('found',{email_status:'verified_guess'}),badPerson('found',{email:null,email_status:'verified_guess',source_url:'https://x.example/',source_block_id:'b1',source_quote:'q'}),badPerson('found',{email_status:'guess',source_url:'https://x.example/',source_block_id:'b1',source_quote:'q'}),
 badPerson('source',{source_url:'https://x.example/'}),badPerson('source',{source_url:'https://x.example/',source_block_id:'b1',source_quote:''}),badPerson('source',{source_url:'https://x.example/',source_block_id:'b1',source_quote:'q'.repeat(601)}),badPerson('source',{source_url:'',source_block_id:'b1',source_quote:'q'}),badPerson('found',{match_confidence:'low'}),badPerson('found',{email:'jordan@other.example.test'}),badPerson('found',{email:'Jordan@HOST'}),badPerson('found',{first_name:''}),
 {constraint:'outreach_people_contacts_lookup_fkey',run:async(f:Fixture)=>insertInto(f,'outreach_people_contacts',{...await person(f),lookup_id:missing})},
 {constraint:'outreach_people_contacts_candidate_fkey',run:async(f:Fixture)=>insertInto(f,'outreach_people_contacts',{...await person(f),candidate_id:missing})},
 {constraint:'outreach_people_contacts_pkey',run:async(f:Fixture)=>{const value=await person(f);await insertInto(f,'outreach_people_contacts',value);return insertInto(f,'outreach_people_contacts',value);}},
];
