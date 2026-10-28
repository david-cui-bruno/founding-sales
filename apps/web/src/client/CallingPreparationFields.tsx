import type {JSX} from 'react';
import type {CallingPreparationProfile} from '@fss/contracts';
type TextField='companyName'|'website'|'addressLine'|'locality'|'regionCode'|'postalCode';
const fields:readonly [TextField,string,number][]=[['companyName','Company name',300],['website','Observed website',500],['addressLine','Office address · optional',300],['locality','City · optional',120],['regionCode','US state code · optional',2],['postalCode','Postal code · optional',12]];
export function CallingPreparationFields({profile,onChange}:{profile:CallingPreparationProfile;onChange:(profile:CallingPreparationProfile)=>void}):JSX.Element{
 return <div className="calling-preparation-fields">{fields.map(([key,label,maxLength])=><label key={key}>{label}<input maxLength={maxLength} required={key==='companyName'} type={key==='website'?'url':'text'} value={profile[key]??''} onChange={event=>onChange({...profile,[key]:event.target.value||null})}/></label>)}
 <label>Office time zone · optional<input placeholder="Unknown · for example America/Chicago" maxLength={100} value={profile.timeZone.kind==='reviewed'?profile.timeZone.timeZone:''} onChange={event=>onChange({...profile,timeZone:event.target.value?{kind:'reviewed',timeZone:event.target.value}:{kind:'unknown'}})}/></label></div>;
}
