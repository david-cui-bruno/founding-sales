import type {OutboundCase,OutboundCaseFixture} from './outboundCases.ts';
const alpha=(f:OutboundCaseFixture)=>f.seeded.alpha.workspaceId;
async function incident(f:OutboundCaseFixture,override:Record<string,unknown>={}){
 const row={workspace_id:alpha(f),mailbox_id:f.mail.alpha.mailboxId,source_kind:'sent_search',source_id:'fixture-source',classification:'transient',reason:'rate_limited',observed_at:'2026-09-23T09:00:00Z',...override};
 const columns=Object.keys(row);
 return f.session.query<{id:string}>(`INSERT INTO mailbox_provider_incidents(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')}) RETURNING id`,Object.values(row));
}
export const PROVIDER_INCIDENT_CONSTRAINT_CASES:readonly OutboundCase[]=[
 {constraint:'mailbox_provider_incidents_pkey',run:async f=>incident(f,{id:(await incident(f)).rows[0]!.id,source_id:'second-source'})},
 {constraint:'mailbox_provider_incidents_one_open_source',run:async f=>{await incident(f);return incident(f);}},
 {constraint:'mailbox_provider_incidents_mailbox_fkey',run:async f=>incident(f,{mailbox_id:f.mail.beta.mailboxId})},
 {constraint:'mailbox_provider_incidents_hold_fkey',run:async f=>{
  const hold=(await f.session.query<{id:string}>(`INSERT INTO active_holds(workspace_id,scope_kind,reason_code,blocked_action_kinds,source_event_kind)
   VALUES($1,'workspace','provider_refusal',ARRAY['email_send'],'fixture') RETURNING id`,[alpha(f)])).rows[0]!.id;
  return incident(f,{workspace_id:f.seeded.beta.workspaceId,mailbox_id:f.mail.beta.mailboxId,hold_id:hold});
 }},
 {constraint:'mailbox_provider_incidents_source_known',run:async f=>incident(f,{source_kind:'unclassified'})},
 {constraint:'mailbox_provider_incidents_source_present',run:async f=>incident(f,{source_id:'raw body or token'})},
 {constraint:'mailbox_provider_incidents_class_known',run:async f=>incident(f,{classification:'probably_safe'})},
 {constraint:'mailbox_provider_incidents_reason_coded',run:async f=>incident(f,{reason:'copied provider text'})},
 {constraint:'mailbox_provider_incidents_binding_shape',run:async f=>incident(f,{binding_sha256:'unknown'})},
 {constraint:'mailbox_provider_incidents_retry_order',run:async f=>incident(f,{retry_at:'2026-09-23T08:59:59Z'})},
 {constraint:'mailbox_provider_incidents_resolution_consistent',run:async f=>incident(f,{resolution:'verified_read'})},
 {constraint:'mailbox_provider_incidents_resolution_order',run:async f=>incident(f,{resolution:'human_revalidated',resolved_at:'2026-09-23T08:59:59Z'})},
];
