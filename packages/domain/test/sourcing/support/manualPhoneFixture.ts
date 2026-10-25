import {createHash,randomUUID} from 'node:crypto';
import type {SourceObservation,QualificationFact} from '@fss/contracts';
import type {SessionQueryable} from '../../../db/queryable.ts';
export function manualPhoneFixture(url='https://source.example.test/phone',values=['(214) 555-0123']){
 const blocks=values.map((text,i)=>({id:`phone-${i}`,text}));
 if(!blocks.length)blocks.push({id:'retained-text',text:'Retained business page, no phone fact extracted.'});
 const source:SourceObservation={id:randomUUID(),url,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(Date.now()-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:false,truncated:false,blocks};
 const facts:QualificationFact[]=values.map((value,i)=>({kind:'business_phone',value,observationId:source.id,blockId:`phone-${i}`}));
 return {observations:[source],facts};
}
export function manualLiteralPhoneFixture(url='https://source.example.test/phone',texts=['Main phone: (214) 555-0123']){
 const evidence=manualPhoneFixture(url,texts);evidence.observations[0]!.firstParty=true;evidence.facts=[];return evidence;
}
export async function seedManualPhoneRun(db:SessionQueryable,workspaceId:string,candidateId:string,evidence=manualPhoneFixture(),revision=1,id=randomUUID()){
 await db.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,state,reason,observations,facts)
 VALUES($1,$2,$3,$4,$5,'retained-test','retained-test','none','unavailable','identity_unresolved',$6,$7)`,[workspaceId,id,candidateId,revision,createHash('sha256').update(id).digest('hex'),JSON.stringify(evidence.observations),JSON.stringify(evidence.facts)]);
 return id;
}
