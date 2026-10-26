import {expect,it} from 'vitest';
import {socialGenerationBrowserResult} from '../../src/server/socialGenerationBoundary.ts';
const path='/social/drafts/request',refusal=(reason:string)=>({status:'refused',replayed:false,reason});
it.each(['draft_requests_pending','voice_guide_changed_or_unavailable','sanitized_facts_required','block_changed','news_source_stale_or_unavailable','owner_required'])('maps finite Social domain refusal %s only',reason=>{const body=refusal(reason);expect(socialGenerationBrowserResult(path,409,body)).toEqual({status:200,body});});
it.each(['command_payload_mismatch','command_device_mismatch','command_kind_mismatch','unauthenticated','session_changed','current_principal_required','client_upgrade_required','unknown_reason'])('preserves auth/envelope/collision refusal %s',reason=>{expect(socialGenerationBrowserResult(path,409,refusal(reason))).toBeNull();});
it('never widens paths/statuses or accepts extra private fields',()=>{
 for(const other of ['/social/posts/approve','/social/drafts/request/receipt','/social/accounts/connect'])expect(socialGenerationBrowserResult(other,409,refusal('block_changed'))).toBeNull();
 for(const status of [200,400,401,403,426,500])expect(socialGenerationBrowserResult(path,status,refusal('block_changed'))).toBeNull();
 expect(socialGenerationBrowserResult(path,409,{...refusal('block_changed'),private:'prose'})).toBeNull();
});
