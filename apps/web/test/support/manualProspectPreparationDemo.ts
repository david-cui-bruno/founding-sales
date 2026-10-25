import assert from 'node:assert/strict';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {manualOrdinaryFixture} from '../../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import type {BrowserAssets} from '../../src/server/hostContract.ts';
import type {ReplyBriefApp} from './replyBriefApp.ts';
import {syntheticBrowserCase} from './syntheticBrowserCase.ts';

export const manualPreparationDemoNotice='SYNTHETIC · fictional manual phone report simulation · NO SEND · no actual attempt';
/** Compose after the existing synthetic asset decorator, before starting the server. */
export function manualProspectPreparationDemoAssets(assets:BrowserAssets):BrowserAssets{
 const decorated=new Map(assets),root=assets.get('/');assert(root);
 const document=new TextDecoder().decode(root.body);assert.equal(document.split('<div id="root">').length,2);
 const notice=`<aside aria-label="Fictional manual activity instructions"><strong>${manualPreparationDemoNotice}</strong><details><summary>Fictional outcome walkthrough and limits</summary><p>All retained prospects here are invented. Prepare manual NO SEND text for the selected observation. Draft review is not an attempt.</p><p>Only in this disposable fictional workspace, you may explicitly simulate a fictional manual phone report: open that prospect's private activity, choose Record a user-performed attempt, and check the attestation solely as part of this invented scenario. No real call occurred. Nothing is recorded until you deliberately save. Do not use this simulation instruction for real prospects.</p><p>To reopen the fictional callback intention after reload: select the same prospect, Open private manual activity, Refresh manual activity, then open the exact report. Its note/time is display-only, not a reminder, next-due queue, booking or action. Reports persist only for this disposable demo lifetime. Manual drafts are lost on reload.</p></details></aside>`;
 // The existing persistent synthetic banner remains the single outer label.
 const html=document.replace('</strong><details><summary>Local demo instructions and limits</summary>',`</strong>${notice}<details><summary>Local demo instructions and limits</summary>`);
 assert.notEqual(html,document);decorated.set('/',{...root,body:new TextEncoder().encode(html)});return decorated;
}
/** Same isolated fixture, same accepted case A input, no inferred candidate/Firm link. */
export async function seedManualProspectPreparationDemo(app:ReplyBriefApp){
 const f=app.fixture,runtime=await f.database.appRuntimeSession();
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 const ids:string[]=[];
 for(const [index,name] of [syntheticBrowserCase.firm,'Other fictional retained prospect (invented)'].entries()){
  const input=manualOrdinaryFixture(785+index);
  input.firmName=`SYNTHETIC ${name}`;input.website=`https://fictional-${index}.example.test/`;
  input.evidence=index===0?`Fictional retained observation for case A. Original SYN-A-01: ${syntheticBrowserCase.messages[0]!.body}`:'Fictional alternate observation for exact-selection checks only.';
  input.sourceUrl=`https://fictional.example.test/${index===0?'SYN-A-01':'OTHER'}`;
  input.preparedBy='Explicitly fictional local fixture, not live research';
  const saved=await withTransaction(runtime,()=>saveCandidate(ctx,input));assert(saved.ok);assert(!saved.value.duplicate);ids.push(saved.value.id);
 }
 assert.equal((await f.db.query('SELECT 1 FROM sourcing_manual_prospect_attempts')).rowCount,0);
 app.chooseIdentity(f.alpha.admin);
 return {candidateId:ids[0]!,otherCandidateId:ids[1]!,label:`SYNTHETIC ${syntheticBrowserCase.firm}`};
}
