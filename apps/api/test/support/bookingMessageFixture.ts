import {randomBytes} from 'node:crypto';
import type {BookingPolicyBindings} from '@fss/contracts';
import type {BookingPolicyRuntime} from '@fss/domain/meetings/bookingPolicyTypes.ts';
import type {BookingConversationRuntime} from '@fss/domain/meetings/bookingConversation.ts';
import type {BookingMessageRuntime} from '@fss/domain/meetings/bookingMessagesRuntime.ts';
import {recordedGmailClient,type GmailFixture} from '@fss/domain/mail/gmailClientFake.ts';
import {localEnvelopeCipher} from '@fss/domain/mail/envelope.ts';
import {storeRefreshToken} from '@fss/domain/mail/tokens.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {mailConfig} from '../../../../packages/domain/test/mail/support/mailWorld.ts';
import {storeFixtureCiGateRecord,FIXTURE_CI_COMMIT,FIXTURE_WORKER_DIGEST} from '../../../../packages/domain/test/release/support/releaseRecords.ts';
import {ciGateReleaseReference} from '@fss/contracts';
import type {bookingCreateSourceFixture} from './bookingCreateFixture.ts';

/** Only existing sender infrastructure is seeded. Booking state must travel through public commands and registered workers. */
export async function setupBookingMessageSender(base:Awaited<ReturnType<typeof bookingCreateSourceFixture>>,policy:BookingPolicyRuntime,bindings:BookingPolicyBindings,conversation:BookingConversationRuntime){
 const gmailFixture:GmailFixture={emailAddress:'owner@booking.example',historyId:'1000',messages:[],refreshToken:randomBytes(24).toString('base64url')};
 const gmail=recordedGmailClient(gmailFixture),cipher=localEnvelopeCipher('booking-message-controlled');
 const config=mailConfig(),ctx=repositoryContext(workspaceScope(base.fixture.alpha.workspaceId,{kind:'user',userId:base.fixture.alpha.admin.userId,role:'admin'}),base.fixture.db);
 const runtime:BookingMessageRuntime={policy,conversation,send:{gmail,cipher,oauth:{...config,clientSecret:randomBytes(24).toString('base64url')},deploymentSendingEnabled:true,workerImageDigest:FIXTURE_WORKER_DIGEST,now:()=>new Date(policy.now())},readSender:async()=>({mailboxId:base.mailbox.id,accountBinding:base.binding,generation:1,authorityRevision:bindings.sender.authorityRevision,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2099-01-01T00:00:00Z',maximumCents:0,reference:'controlled-configured-zero-cost-not-actual-gmail-evidence'})};
 await base.fixture.db.query(`UPDATE mailboxes SET sync_state='ready',history_id='1000',history_id_updated_at=now(),baseline_from_at=now()-interval '30 days',baseline_completed_at=now(),coverage_watermark_at=now() WHERE workspace_id=$1 AND id=$2`,[base.fixture.alpha.workspaceId,base.mailbox.id]);
 await storeRefreshToken(ctx,{mailboxId:base.mailbox.id,plaintext:gmailFixture.refreshToken!,cipher});
 await base.fixture.db.query(`INSERT INTO sending_domains(workspace_id,domain,is_primary,spf_pass,dkim_pass,dmarc_pass,authentication_checked_at,authentication_checked_by_user_id,postmaster_reviewed_at,automated_sending_enabled,automated_sending_enabled_at) VALUES($1,'booking.example',true,true,true,true,now(),$2,now(),true,now())`,[base.fixture.alpha.workspaceId,base.fixture.alpha.admin.userId]);
 await storeFixtureCiGateRecord(base.fixture.db,'6240001');
 await base.fixture.db.query(`INSERT INTO workspace_settings(workspace_id,setting_key,version,value,change_note,changed_by_user_id) VALUES($1,'sending_enabled',1,$2::jsonb,'controlled sender infrastructure',$3)`,[base.fixture.alpha.workspaceId,JSON.stringify({enabled:true,releaseGateReference:ciGateReleaseReference('6240001',FIXTURE_CI_COMMIT)}),base.fixture.alpha.admin.userId]);
 return {runtime,gmail,gmailFixture};
}
