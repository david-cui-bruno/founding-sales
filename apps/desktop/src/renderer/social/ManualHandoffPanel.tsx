import {useMemo} from 'react';
import {useSessionEpoch} from '../app/drafts.tsx';
import {operations} from '../app/bridges.ts';
import {SocialManualHandoff,type ManualHandoffPorts} from './ManualHandoff.tsx';
import {SocialImage} from './SocialImage.tsx';
export function ManualHandoffPanel({postId,revision}:{postId:string;revision:number}){
 const epoch=useSessionEpoch();
 const prepared=useMemo<{ports:ManualHandoffPorts;key:string}>(()=>{
  const commandId=crypto.randomUUID();const client=()=>{const api=operations();if(!api)throw new Error('unavailable');return api;};
  const ports:ManualHandoffPorts={read:async input=>{const r=await client().read('social.manualHandoff',input);return r.view?{ok:true,value:r.view}:{ok:false,reason:r.reason??'unavailable'};},confirm:async input=>{const r=await client().command('social.confirmHandoff',{...input,commandId});return r.accepted&&r.approvalId?{ok:true,value:{approvalId:r.approvalId}}:{ok:false,reason:r.reason??'unavailable'};},use:async input=>{const r=await client().command('social.useHandoff',input);if(!r.accepted)throw new Error(r.reason??'unavailable');}};return {ports,key:commandId};
 },[postId,revision,epoch]);
 return <SocialManualHandoff key={prepared.key} postId={postId} revision={revision} ports={prepared.ports} renderImage={(image,onReady)=><SocialImage assetId={image.assetId} version={image.version} alt={image.altText} onReady={onReady}/>}/>;
}
