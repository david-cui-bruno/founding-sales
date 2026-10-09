import type {RepositoryContext} from '../db/workspaceScope.ts';
import {businessAccountBinding} from '../business/acquisition.ts';
import {MAIL_CAPTURE_VERSION,type MailCaptureProof} from './crmSources.ts';
export interface BackfillAuthority{importId:string;proof:MailCaptureProof;fromAt:string;toAt:string;fromEpochMicroseconds:string;toEpochMicroseconds:string;historyAnchor:string|null;historyCursor:string|null;mailboxEmail:string}
interface AuthorityRow extends Record<string,unknown>{import_id:string;mailbox_id:string;owner_user_id:string;provider_account_id:string;account_binding:string;generation:number;controls_revision:number;policy_revision:number;disclosure_version:string;disclosure_sha256:string;grant_receipt:string;provider_policy_receipt:string;evaluation_receipt:string;release_receipt:string;from_at:Date;to_at:Date;from_epoch_microseconds:string;to_epoch_microseconds:string;history_anchor:string|null;history_cursor:string|null;email_address:string}
/** DB-only account/policy snapshot. Receipt references are not external verification. */
export async function readBackfillAuthority(context:RepositoryContext,importId:string,lock=false):Promise<BackfillAuthority|null>{
 if(context.scope.actor.kind!=='system'||context.scope.actor.component!=='worker')return null;
 const identified=(await context.db.query<{mailbox_id:string}>('SELECT mailbox_id FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,importId])).rows[0];if(identified===undefined)return null;
 if(lock){
  await context.db.query('SELECT id FROM mailboxes WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE',[context.scope.workspaceId,identified.mailbox_id]);
  await context.db.query('SELECT mailbox_id FROM crm_mail_capture_controls WHERE workspace_id=$1 AND mailbox_id=$2 FOR SHARE',[context.scope.workspaceId,identified.mailbox_id]);
  await context.db.query('SELECT mailbox_id FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2 FOR SHARE',[context.scope.workspaceId,identified.mailbox_id]);
  await context.db.query('SELECT id FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,importId]);
 }
 const row=(await context.db.query<AuthorityRow>(`SELECT i.id AS import_id,i.mailbox_id,i.owner_user_id,i.provider_account_id,i.account_binding,i.generation,i.controls_revision,i.policy_revision,i.from_at,i.to_at,(extract(epoch FROM i.from_at)*1000000)::bigint::text AS from_epoch_microseconds,(extract(epoch FROM i.to_at)*1000000)::bigint::text AS to_epoch_microseconds,i.history_anchor,i.history_cursor,m.email_address,c.disclosure_version,c.disclosure_sha256,c.grant_receipt,c.provider_policy_receipt,c.evaluation_receipt,c.release_receipt
 FROM crm_mail_imports i JOIN mailboxes m ON m.workspace_id=i.workspace_id AND m.id=i.mailbox_id
 JOIN crm_mail_capture_controls c ON c.workspace_id=i.workspace_id AND c.mailbox_id=i.mailbox_id
 JOIN crm_business_policies p ON p.workspace_id=i.workspace_id AND p.mailbox_id=i.mailbox_id
 JOIN workspace_memberships member ON member.workspace_id=i.workspace_id AND member.user_id=i.owner_user_id
 WHERE i.workspace_id=$1 AND i.id=$2 AND m.status='connected' AND member.status='active'
 AND m.owner_user_id=i.owner_user_id AND c.owner_user_id=i.owner_user_id AND p.owner_user_id=i.owner_user_id
 AND m.provider_account_id=i.provider_account_id AND c.provider_account_id=i.provider_account_id AND p.provider_account_id=i.provider_account_id
 AND m.generation=i.generation AND c.generation=i.generation AND p.generation=i.generation
 AND c.account_binding=i.account_binding AND p.account_binding=i.account_binding
 AND c.revision=i.controls_revision AND c.policy_revision=i.policy_revision AND p.revision=i.policy_revision AND c.enabled AND p.enabled`,[context.scope.workspaceId,importId])).rows[0];
 if(row===undefined||businessAccountBinding(context.scope.workspaceId,{id:row.mailbox_id,owner_user_id:row.owner_user_id,provider_account_id:row.provider_account_id,email_address:row.email_address,generation:row.generation,status:'connected'})!==row.account_binding)return null;
 return {importId:row.import_id,mailboxEmail:row.email_address,fromAt:row.from_at.toISOString(),toAt:row.to_at.toISOString(),fromEpochMicroseconds:row.from_epoch_microseconds,toEpochMicroseconds:row.to_epoch_microseconds,historyAnchor:row.history_anchor,historyCursor:row.history_cursor,proof:{workspaceId:context.scope.workspaceId,mailboxId:row.mailbox_id,ownerUserId:row.owner_user_id,providerAccountId:row.provider_account_id,accountBinding:row.account_binding,generation:row.generation,controlsRevision:row.controls_revision,policyRevision:row.policy_revision,disclosureVersion:row.disclosure_version,disclosureSha256:row.disclosure_sha256,grantReceipt:row.grant_receipt,providerPolicyReceipt:row.provider_policy_receipt,evaluationReceipt:row.evaluation_receipt,releaseReceipt:row.release_receipt,captureVersion:MAIL_CAPTURE_VERSION}};
}
