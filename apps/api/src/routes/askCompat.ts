import {compareVersions,semanticVersionSchema,type askResponseSchema} from '@fss/contracts';
import type {z} from 'zod';
import type {AuthenticatedPrincipal} from '../auth/sessions.ts';

/** Installed 1.0.51 (release stamp d49dda37) strictly parses pre-relationship
 * records and operational-only tasks. Reads use the authenticated session row,
 * never an untrusted request header. Newer clients retain the current shape. */
export function readsLegacyAsk(principal:Pick<AuthenticatedPrincipal,'clientVersion'>):boolean{
 const version=semanticVersionSchema.safeParse(principal.clientVersion);
 return version.success&&compareVersions(version.data,'1.0.51')<=0;
}
export function legacyAskResponse(body:z.infer<typeof askResponseSchema>):unknown{
 if(body.operation==='records')return {...body,records:body.records.map(({recordId,kind,name,firmId})=>({recordId,kind,name,firmId}))};
 return body;
}
