import {expect,it} from 'vitest';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {readBookingPolicySettingsOperation,changeBookingPolicySettingsOperation} from '../src/main/bookingPolicyBridge.ts';
import {BRIDGE_ANSWERS} from './support/bridgeAnswers.ts';

it.each(['read','change'] as const)('withholds a %s response after the signed-in identity changes during an authenticated wait',async(kind)=>{
  let generation=0,finish:(answer:{status:number;body:unknown})=>void=()=>undefined;
  const response=new Promise<{status:number;body:unknown}>(resolve=>{finish=resolve;});
  let started:()=>void=()=>undefined;const waiting=new Promise<void>(resolve=>{started=resolve;});
  const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.4.0',accessToken:async()=>({token:'controlled-session',generation:0}),send:async()=>{started();return await response;}});
  const deps={api,identity:{current:()=>generation}};
  const pending=kind==='read'?readBookingPolicySettingsOperation(deps):changeBookingPolicySettingsOperation(deps,{commandId:'11111111-1111-4111-8111-111111111111',action:'revoke',expectedRevision:1});
  await waiting;generation=1;
  finish({status:200,body:kind==='read'?BRIDGE_ANSWERS['/meetings/booking-policy']:{status:'accepted',replayed:false,result:{revision:2}}});
  expect(await pending).toEqual(kind==='read'?{view:null}:{revision:null,reason:'session_changed'});
});
