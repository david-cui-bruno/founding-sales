import {it,expect} from 'vitest';
import {browserApiPathAllowed} from '../../src/shared/browserContract.ts';
import {privateDraftBrowserResult} from '../../src/server/privateDraftBoundary.ts';
it('voice boundary exposes exactly three POST paths, never broad settings or publishing',()=>{
 for(const operation of ['read','receipt','save']){const path=`/social/voice-preferences/${operation}`;expect(browserApiPathAllowed('POST',path)).toBe(true);for(const method of ['GET','PUT','DELETE'])expect(browserApiPathAllowed(method,path)).toBe(false);for(const suffix of ['/extra','?x=1','/../save'])expect(browserApiPathAllowed('POST',path+suffix)).toBe(false);}
 for(const path of ['/social/voice-preferences','/social/voice-preferences/delete','/social/voice-preferences/restart','/social/voice-preferences/generate','/social/posts/save','/social/drafts/request'])expect(browserApiPathAllowed('POST',path)).toBe(false);
});
it('only finite content conflicts are projected, authority and receipt collisions remain fail closed',()=>{
 for(const reason of ['already_exists','not_found','stale_revision','not_removed','removed'])expect(privateDraftBrowserResult('/social/voice-preferences/save',409,{status:'refused',replayed:false,reason})?.status).toBe(200);
 for(const reason of ['command_payload_mismatch','command_kind_mismatch','command_device_mismatch','device_revoked','unknown'])expect(privateDraftBrowserResult('/social/voice-preferences/save',409,{status:'refused',replayed:false,reason})).toBeNull();
});
