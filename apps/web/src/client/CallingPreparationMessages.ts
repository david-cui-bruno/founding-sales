import type {CallingPreparationReceipt} from '@fss/contracts';
type Reason=Extract<CallingPreparationReceipt,{state:'refused'}>['reason'];
export function companySaveRefusal(reason:Reason):string{
 switch(reason){
  case 'admin_only':case 'authority_changed':return 'A current workspace admin session is required to save company details.';
  case 'candidate_unavailable':case 'candidate_changed':case 'choice_not_kept':case 'choice_changed':return 'The kept company or number changed. Review the current source again.';
  case 'source_withdrawn':case 'creator_inactive':return 'The retained source or its access is no longer available.';
  case 'preparation_version_conflict':return 'Saved company details changed. Review them before updating.';
  case 'preparation_terminal':return 'These saved details were withdrawn. This retained choice cannot be saved again.';
  case 'profile_invalid':case 'office_country_unresolved':return 'Review the company fields and confirm that the office is in the United States.';
  case 'duplicate_recorded_company':return 'Select the matching company from Recorded companies before saving another.';
  case 'firm_changed':case 'route_changed':return 'The saved company or number changed. Review current details.';
 }
}
