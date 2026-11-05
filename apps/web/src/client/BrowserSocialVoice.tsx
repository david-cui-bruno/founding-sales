import {useEffect,useState,type JSX} from 'react';
import {socialCalibrationReadSchema,type SocialCalibrationResult} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {BrowserSocialCalibration} from './BrowserSocialCalibration.tsx';
import {BrowserVoicePreferences} from './BrowserVoicePreferences.tsx';

export function BrowserSocialVoice({client}:{client:BrowserClient}):JSX.Element{
 const [completion,setCompletion]=useState<SocialCalibrationResult|null|undefined>(),[failed,setFailed]=useState(false),[refresh,setRefresh]=useState(0);
 const managed=client.current?.status==='signed_in'&&client.current.role==='admin';
 useEffect(()=>{
  if(!managed)return;
  let active=true;const epoch=client.epoch;
  const current=()=>{if(!active||!client.isCurrent(epoch))throw Error('Voice view changed');};
  void client.request('/social/calibration/read',socialCalibrationReadSchema,{},current).then(result=>{current();setCompletion(result.completion);setFailed(false);}).catch(()=>{if(active){setCompletion(undefined);setFailed(true);}});
  return()=>{active=false;};
 },[client,refresh,managed]);
 if(!managed)return <BrowserVoicePreferences client={client}/>;
 return <div className="social-voice">
  {completion===undefined?<div role="status"><h3>{failed?'Your voice setup couldn’t be loaded':'Reading your voice setup…'}</h3>{failed?<button onClick={()=>{setFailed(false);setRefresh(value=>value+1);}}>Try loading again</button>:null}</div>:completion?<>
   <span className="social-status is-ready">Calibration accepted</span><h2 className="social-voice-title">You’ve found your voice.</h2><p>You’ve reviewed three private drafts for voice and accuracy. You don’t need to review them again to continue setup.</p>
   <p className="social-caption">Accepted {new Date(completion.completedAt).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'})}. Publishing is a separate choice in your plan.</p>
  </>:<BrowserSocialCalibration client={client} onCompleted={()=>setRefresh(value=>value+1)}/>}
  <details className="social-details"><summary>Your voice preferences</summary><BrowserVoicePreferences client={client}/></details>
 </div>;
}
