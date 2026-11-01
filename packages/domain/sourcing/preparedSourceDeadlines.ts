import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ManualProspectRow} from './manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {preparedCaptureAuthority} from './preparedCapture.ts';

export interface SourceExpiry extends Record<string,unknown> {url:string;expires_at:Date}
/** Earliest retained-evidence expiry of every candidate/permitted/dependency URL group (rtrim '/'). One owner
 * for the prepared brief and Calling's prepared phone read, so both bound a page by the same deadline. */
export async function preparedSourceExpirations(ctx:RepositoryContext,rows:readonly ManualProspectRow[],snapshots:readonly ManualPhoneSnapshot[]):Promise<SourceExpiry[]>{
 const candidateUrls=rows.flatMap(r=>Array.isArray(r['source_urls'])?r['source_urls'].filter((url):url is string=>typeof url==='string'):[]);
 const urls=[...new Set([...candidateUrls,...snapshots.flatMap(s=>[...s.permitted_urls,...preparedCaptureAuthority(s).dependencyUrls])])].map(url=>url.replace(/\/+$/u,''));
 if(!urls.length)return [];
 return (await ctx.db.query<SourceExpiry>(`SELECT rtrim(source_reference,'/') AS url,min(retention_expires_at) AS expires_at FROM evidence_items
 WHERE workspace_id=$1 AND rtrim(source_reference,'/')=ANY($2::text[]) AND retention_expires_at IS NOT NULL GROUP BY rtrim(source_reference,'/') ORDER BY 1`,[ctx.scope.workspaceId,urls])).rows;
}
/** Deadline (ms) by each permitted page URL, as the prepared brief bounds an admitted page. */
export function permittedPageDeadlines(expiry:readonly SourceExpiry[],snapshots:readonly ManualPhoneSnapshot[]):Map<string,number>{
 const deadlines=new Map(expiry.map(e=>[e.url,e.expires_at.getTime()]));
 return new Map(snapshots.flatMap(s=>s.permitted_urls.flatMap(url=>{const at=deadlines.get(url.replace(/\/+$/u,''));return at===undefined?[]:[[url,at] as const];})));
}
/** Attach each snapshot's own page deadlines so the pure phone projection can bound every admitted page.
 * Part of the snapshot, so a deadline change between repeated reads is a changed dependency. */
export async function withPreparedSourceDeadlines(ctx:RepositoryContext,rows:readonly ManualProspectRow[],snapshots:ManualPhoneSnapshot[]):Promise<ManualPhoneSnapshot[]>{
 const byUrl=permittedPageDeadlines(await preparedSourceExpirations(ctx,rows,snapshots),snapshots);
 return snapshots.map(s=>({...s,prepared_source_deadlines:Object.fromEntries(s.permitted_urls.flatMap(url=>byUrl.has(url)?[[url,byUrl.get(url)!] as const]:[]))}));
}
