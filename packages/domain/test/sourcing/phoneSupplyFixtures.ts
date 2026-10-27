import {createHash} from 'node:crypto';
import type {ProspectPhoneObservation} from '@fss/contracts';
import type {PageFetchResult} from '../../research/providers.ts';
import type {PhoneDiscoveryRun} from '../../sourcing/prospectPhoneDiscoveryStore.ts';
export const PHONE_SUPPLY_RUN='00000000-0000-4000-8000-000000000001';
export const PHONE_SUPPLY_NOW=Date.parse('2026-10-27T02:00:00.000Z');
export const PHONE_SUPPLY_SITE='https://capacity.example.test/';
export function phoneSupplyPage(text:string,path='contact',contentType='text/html'):PageFetchResult['pages'][number]{
 const body=new TextEncoder().encode(text);
 return {url:PHONE_SUPPLY_SITE+path,body,contentType,contentHash:createHash('sha256').update(body).digest('hex'),retrievedAt:new Date(PHONE_SUPPLY_NOW-1000).toISOString(),firstParty:true};
}
export function phoneSupplyObservation(texts:string[],index=2):ProspectPhoneObservation{
 const blocks=texts.map((text,offset)=>({id:`b${offset+1}`,text}));
 return {id:`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,url:PHONE_SUPPLY_SITE+`page-${index}`,retrievedAt:new Date(PHONE_SUPPLY_NOW-1000).toISOString(),contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
}
export function phoneSupplyRun(observations:ProspectPhoneObservation[]):PhoneDiscoveryRun{
 return {id:PHONE_SUPPLY_RUN,candidate_id:PHONE_SUPPLY_RUN,candidate_revision:1,creator_user_id:PHONE_SUPPLY_RUN,creator_ref:PHONE_SUPPLY_RUN,method:'company-public-phone-v1',state:'complete',reason:null,requested_at:new Date(PHONE_SUPPLY_NOW-2000),deadline_at:new Date(PHONE_SUPPLY_NOW+10000),checked_at:new Date(PHONE_SUPPLY_NOW),expires_at:new Date(PHONE_SUPPLY_NOW+60000),dispatched_at:new Date(PHONE_SUPPLY_NOW-1500),dispatch_finished_at:new Date(PHONE_SUPPLY_NOW),content:{website:PHONE_SUPPLY_SITE,sourceUrls:[PHONE_SUPPLY_SITE],observations}};
}
export const phoneSupplyHtml=(texts:string[])=>texts.map(text=>`<p>${text}</p>`).join('');
