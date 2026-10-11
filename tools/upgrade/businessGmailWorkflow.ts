import assert from 'node:assert/strict';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {readBusinessPolicy,saveBusinessPolicy,readBusinessReview} from '@fss/domain/business/acquisition.ts';
import {readBusinessRules,saveBusinessRule} from '@fss/domain/business/rules.ts';
import {readCrmMailImport,requestCrmMailImport} from '@fss/domain/mail/crmBackfill.ts';
import type {FixtureHandles} from './fixture.ts';

export const BUSINESS_GMAIL_UPGRADE_WORKFLOW='crm.business Gmail policy/rules (runtime domain)';
/** Surviving base mailbox, runtime-role reads and disabled commands only; no external acquisition authority. */
export async function runBusinessGmailUpgradeWorkflow(context:RepositoryContext&{db:SessionQueryable},handles:FixtureHandles):Promise<string>{
 assert(handles.mailboxId,'the deployed fixture must retain its named mailbox');
 const owner=repositoryContext(workspaceScope(handles.workspaceId,{kind:'user',userId:handles.salespersonUserId,role:'salesperson'}),context.db);
 const transact=<Value>(run:()=>Promise<Value>)=>withTransaction(context.db,run);
 const before=await transact(()=>readBusinessPolicy(owner,handles.mailboxId!));
 assert(before&&before.accountBinding&&before.generation);
 assert.equal(before.ownerUserId,handles.salespersonUserId);
 assert.equal(before.ready,false);
 const saved=await transact(()=>saveBusinessPolicy(owner,{mailboxId:handles.mailboxId!,expectedGeneration:before.generation!,expectedAccountBinding:before.accountBinding!,expectedRevision:before.revision,enabled:false,disclosure:null}));
 assert(saved.ok,'disabled policy configuration must work as the surviving mailbox owner');
 const current=await transact(()=>readBusinessPolicy(owner,handles.mailboxId!));
 assert.equal(current?.enabled,false);assert.equal(current?.ready,false);assert.equal(current?.revision,before.revision+1);
 const empty=await transact(()=>readBusinessRules(owner,{mailboxId:handles.mailboxId!}));assert(empty);
 const endpoint='upgrade.business-correspondent@example.test';
 const existing=empty.rules.find(rule=>rule.endpoint===endpoint);
 const rule=await transact(()=>saveBusinessRule(owner,{mailboxId:handles.mailboxId!,expectedGeneration:before.generation!,expectedAccountBinding:before.accountBinding!,expectedRevision:existing?.revision??0,endpoint,decision:'exclude',active:false}));
 assert(rule.ok);assert.equal(rule.value.captureAllowed,false);
 const rules=await transact(()=>readBusinessRules(owner,{mailboxId:handles.mailboxId!}));
 assert(rules?.rules.some(value=>value.endpoint===endpoint&&value.decision==='exclude'&&value.active===false&&value.revision===rule.value.revision),'the new account-scoped rule table must have runtime grants and preserve its exact disabled revision');
 const review=await transact(()=>readBusinessReview(owner,{mailboxId:handles.mailboxId!,limit:20}));assert(review);assert.equal(review.captureAllowed,false);
 const admission=await transact(()=>requestCrmMailImport(owner,{mailboxId:handles.mailboxId!}));assert.equal(admission.ok,false,'disabled controls cannot start an acquisition import');
 const coverage=await transact(()=>readCrmMailImport(owner,{mailboxId:handles.mailboxId!}));assert.equal(coverage,null,'disabled existing mailbox must not invent a CRM import or coverage');
 const disabled=await transact(()=>readBusinessPolicy(owner,handles.mailboxId!));assert.equal(disabled?.enabled,false);
 return 'surviving mailbox owner reads/saves disabled qualified policy, persists an inactive account-scoped correspondent rule, and reads review plus absent unrequested import coverage; no provider/consent/authority';
}
