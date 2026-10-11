import type { RepositoryContext } from '../db/workspaceScope.ts';
import { businessAccountBinding } from '../business/acquisition.ts';
import { headerValue, type GmailMessageMetadata } from './gmailClient.ts';
import { normalizeIdentityEndpoint } from '../crm/endpoints.ts';

export const BUSINESS_QUALIFICATION_VERSION = 'business-metadata-qualified-v2';
/** Qualification only examines already acquired metadata and current server evidence.
 * It cannot fetch bytes, invoke a model, promote identity or authorize acquisition. */
export async function qualifyBusinessMailMetadata(context: RepositoryContext, input: {
 mailboxId:string;ownerUserId:string;providerAccountId:string;generation:number;metadata:GmailMessageMetadata;
}):Promise<{category:'business'|'uncertain'|'newsletter'|'receipt'|'routine_support';reason:string;classifierVersion:string}> {
 const result=(category:'business'|'uncertain'|'newsletter'|'receipt'|'routine_support',reason:string)=>({category,reason,classifierVersion:BUSINESS_QUALIFICATION_VERSION});
 const mailbox=(await context.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>('SELECT * FROM mailboxes WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.mailboxId])).rows[0];
 if(!mailbox||mailbox.owner_user_id!==input.ownerUserId||mailbox.provider_account_id!==input.providerAccountId||mailbox.generation!==input.generation||mailbox.status!=='connected')return result('uncertain','account_evidence_unavailable');
 const policy=(await context.db.query<{qualification_version:string}>('SELECT qualification_version FROM crm_business_policies WHERE workspace_id=$1 AND mailbox_id=$2',[context.scope.workspaceId,input.mailboxId])).rows[0];
 if(policy?.qualification_version!==BUSINESS_QUALIFICATION_VERSION)return result('uncertain','unclassified_metadata');
 const binding=businessAccountBinding(context.scope.workspaceId,mailbox);
 const participants=[headerValue(input.metadata.headers,'From'),headerValue(input.metadata.headers,'To'),headerValue(input.metadata.headers,'Cc')].flatMap(value=>[...(value??'').matchAll(/([^<>\s,]+@[^<>\s,]+)/gu)]).flatMap(match=>{const endpoint=normalizeIdentityEndpoint('email',match[1]!);return endpoint&&endpoint!==mailbox.email_address.toLowerCase()?[endpoint]:[];});
 const subject=headerValue(input.metadata.headers,'Subject')??'';
 if(input.metadata.labelIds.includes('DRAFT'))return result('uncertain','draft_excluded');
 const rules=(await context.db.query<{decision:string}>(`SELECT decision FROM crm_business_correspondent_rules WHERE workspace_id=$1 AND mailbox_id=$2 AND owner_user_id=$3 AND account_binding=$4 AND endpoint=ANY($5::text[]) AND active FOR SHARE`,[context.scope.workspaceId,input.mailboxId,input.ownerUserId,binding,participants])).rows;
 if(rules.some(rule=>rule.decision==='include')&&rules.some(rule=>rule.decision==='exclude'))return result('uncertain','correspondent_rule_conflict');
 if(rules.some(rule=>rule.decision==='exclude'))return result('routine_support','correspondent_explicitly_excluded');
 if(rules.some(rule=>rule.decision==='include'))return result('business','correspondent_explicitly_included');
 const automated=headerValue(input.metadata.headers,'Auto-Submitted');
 if(headerValue(input.metadata.headers,'List-Id')||headerValue(input.metadata.headers,'List-Unsubscribe'))return result('newsletter','automated_list');
 if(automated&&automated.toLowerCase()!=='no')return result('routine_support','automated_message');
 if(/\b(?:receipt|payment confirmation|verification code|password reset|security alert)\b/iu.test(subject))return result('receipt','routine_transaction');
 const substantive=/\b(?:demo|proposal|quote|contract|pricing|property management|partnership|customer|consultation|implementation|onboarding|sales|purchase order)\b/iu.test(subject);
 if(substantive&&participants.length>0)return result('business','substantive_business_subject');
 const relationshipSupported=(await context.db.query(`SELECT 1 FROM crm_identity_endpoints e JOIN crm_endpoint_claims c ON c.workspace_id=e.workspace_id AND c.endpoint_id=e.id JOIN crm_selected_sources s ON s.workspace_id=c.workspace_id AND s.id=c.source_id JOIN crm_people p ON p.workspace_id=c.workspace_id AND p.id=c.person_id WHERE e.workspace_id=$1 AND e.kind='email' AND e.value=ANY($2::text[]) AND c.status='current' AND NOT c.shared AND NOT c.source_invalidated AND s.availability='available' AND s.revision=c.source_revision AND s.content_hash=c.source_hash AND s.owner_user_id=$3 AND p.owner_user_id=$3 LIMIT 1`,[context.scope.workspaceId,participants,input.ownerUserId])).rows.length>0;
 const supported=relationshipSupported||(await context.db.query(`SELECT 1 FROM crm_business_conversations WHERE workspace_id=$1 AND mailbox_id=$2 AND owner_user_id=$3 AND account_binding=$4 AND metadata_availability='available' AND human_decision='include' AND participants ?| $5::text[] LIMIT 1`,[context.scope.workspaceId,input.mailboxId,input.ownerUserId,binding,participants])).rows.length>0;
 if(supported&&subject.trim().length>3&&!/\b(?:newsletter|unsubscribe|digest|notification)\b/iu.test(subject))return result('business','supported_business_correspondent');
 return result('uncertain','business_context_uncertain');
}
