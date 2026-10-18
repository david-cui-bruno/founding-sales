import {compareVersions,semanticVersionSchema,type OutreachControl} from '@fss/contracts';
import type {AuthenticatedPrincipal} from '../auth/sessions.ts';

/** Installed 1.0.51's strict v2 parser requires this retired field. Return only
 * an inert tombstone, never stored activation settings or authority. Selection
 * uses the authenticated session version, not a request header. */
export function legacyOutreachControl(view:OutreachControl,principal:Pick<AuthenticatedPrincipal,'clientVersion'>):unknown{
 const version=semanticVersionSchema.safeParse(principal.clientVersion);
 if(!version.success||compareVersions(version.data,'1.0.51')>0)return view;
 return {...view,emailAdmission:{revision:0,enabled:false,ownerUserId:null,mailboxId:null,sequenceVersionId:null,evaluation:null,configurationSha256:null,ready:false,reasons:['automatic_admission_removed']}};
}
