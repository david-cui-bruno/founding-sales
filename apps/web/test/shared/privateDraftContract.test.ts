import {expect,it} from 'vitest';
import {browserApiPathAllowed} from '../../src/shared/browserContract.ts';
import {privateDraftBrowserResult} from '../../src/server/privateDraftBoundary.ts';
import {privateDraftPendingSchema,privateDraftCanonicalJson} from '../../src/client/PrivateDraftCustody.ts';
it('admits only four exact POST private composition operations, not publishing or aliases',()=>{
 for(const operation of ['list','read','receipt','save']){const path=`/social/private-drafts/${operation}`;expect(browserApiPathAllowed('POST',path)).toBe(true);for(const method of ['GET','PUT','DELETE'])expect(browserApiPathAllowed(method,path)).toBe(false);for(const suffix of ['/extra','?x=1','/../save'])expect(browserApiPathAllowed('POST',path+suffix)).toBe(false);}
 for(const path of ['/social/private-drafts','/social/private-drafts/delete','/social/private-drafts/approve','/social/private-drafts/schedule','/social/private-drafts/publish','/social/posts/save','/social/drafts/request'])expect(browserApiPathAllowed('POST',path)).toBe(false);
});
it('projects only exact finite content-state refusals, never collision or principal boundary failure',()=>{
 expect(privateDraftBrowserResult('/social/private-drafts/save',409,{status:'refused',replayed:false,reason:'stale_revision'})?.status).toBe(200);
 for(const reason of ['command_id_conflict','device_revoked','unknown'])expect(privateDraftBrowserResult('/social/private-drafts/save',409,{status:'refused',replayed:false,reason})).toBeNull();
 expect(privateDraftBrowserResult('/social/posts/save',409,{status:'refused',replayed:false,reason:'stale_revision'})).toBeNull();
});
it('custody is strict IDs-only metadata and payload hash canonicalization is stable',()=>{
 const metadata={identity:'opaque',expiresAt:'2026-12-01T00:00:00.000Z',commandId:'11111111-1111-4111-8111-111111111111',operation:'create',payloadSHA256:'a'.repeat(64)};expect(privateDraftPendingSchema.safeParse(metadata).success).toBe(true);for(const field of ['text','origin','source_selection','payload','url'])expect(privateDraftPendingSchema.safeParse({...metadata,[field]:'private'}).success).toBe(false);expect(privateDraftCanonicalJson({z:1,a:{b:2,a:'value'},skip:undefined})).toBe('{"a":{"a":"value","b":2},"z":1}');
});
