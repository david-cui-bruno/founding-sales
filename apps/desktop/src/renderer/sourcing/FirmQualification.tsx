import {useEffect,useState,type JSX} from 'react';
import type {QualificationView} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
import {QualificationPanel} from './QualificationPanel.tsx';
/** No source evidence is put in the offline Today cache. */
export function FirmQualification({firmId,enabled=true}:{firmId:string;enabled?:boolean}):JSX.Element|null {
 const [value,setValue]=useState<{firmId:string;view:QualificationView}|null>(null);
 useEffect(()=>{let active=true;const api=operations();if(api)void api.read('sourcing.firmQualification',{firmId}).then(answer=>{if(active)setValue(answer.view?{firmId,view:answer.view}:null);}).catch(()=>{if(active)setValue(null);});return()=>{active=false;};},[firmId]);
 if(!value||value.firmId!==firmId)return null;
 return <QualificationPanel candidateId={value.view.candidateId} revision={value.view.candidateRevision} enabled={enabled}/>;
}
