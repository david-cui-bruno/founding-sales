import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {validateSyntheticAcceptance,claimSyntheticAcceptanceDirectory,SYNTHETIC_ACCEPTANCE_CRITICAL_SOURCES} from './support/syntheticAcceptanceApproval.ts';
const bytes=(value:unknown)=>Buffer.from(JSON.stringify(value));const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
function input(changes:Record<string,unknown>={}){const source=Buffer.from('frozen source');const labelsBytes=bytes({cases:['dev_01','dev_02','dev_05','dev_06','dev_08','dev_10','dev_11'].map(caseId=>({caseId,syntheticText:'Frozen text',expectedOutcome:'Frozen expected',forbiddenOutcome:'Frozen forbidden',eventAt:'2026-10-12T14:00:00Z'}))});const scopeBytes=bytes({scopeVersion:2,maxRequestInputBytes:30000,maxNativeOutputTokens:4096,maxProbeOutputTokens:32,runId:randomUUID(),modelVersion:'us.anthropic.claude-sonnet-5-5',labelsSha256:sha(labelsBytes),extractionIds:['dev_01','dev_02','dev_05','dev_08'],askIds:['dev_01','dev_05','dev_06','dev_08','dev_10','dev_11'],maxSteps:41,maxCents:500,maxAskSteps:6,maxAskInputBytes:25000,maxAskOutputTokens:1000,askQuestions:Object.fromEntries(['dev_01','dev_05','dev_06','dev_08','dev_10','dev_11'].map(id=>[id,'Frozen question'])),sourceSha256:Object.fromEntries(SYNTHETIC_ACCEPTANCE_CRITICAL_SOURCES.map(path=>[path,sha(source)])),stage:'history_investigation',thinking:'disabled',pricing:{inputTokenPriceMicros:3.3,outputTokenPriceMicros:16.5,basis:'conservative_upper_bound_not_invoice'},...changes});return {scopeBytes,labelsBytes,approvalBytes:bytes({approved:true,approvedBy:'David Cui',scopeSha256:sha(scopeBytes),humanLabelsReviewed:true,reference:'Exact synthetic run approval'}),readSource:()=>source};}
it('accepts independently approved stronger-model stage without changing labels or claiming quality',()=>{expect(validateSyntheticAcceptance(input()).scope).toMatchObject({modelVersion:'us.anthropic.claude-sonnet-5-5',stage:'history_investigation',thinking:'disabled',maxAskSteps:6});});
it.each([{maxSteps:51},{maxCents:1001},{modelVersion:'automatic-fallback'},{thinking:'adaptive'},{maxAskSteps:3},{maxSteps:25},{sourceSha256:{}},{pricing:undefined},{pricing:{inputTokenPriceMicros:1.1,outputTokenPriceMicros:5.5,basis:'conservative_upper_bound_not_invoice'}}])('refuses expanded, mismatched or unbound scopes before dispatch (%j)',changes=>{expect(()=>validateSyntheticAcceptance(input(changes))).toThrow();});
it('requires exact owner approval and unchanged source/labels before claiming a once-only marker',()=>{const value=input();expect(()=>validateSyntheticAcceptance({...value,approvalBytes:bytes({approved:false})})).toThrow();expect(()=>validateSyntheticAcceptance({...value,scopeBytes:Buffer.concat([value.scopeBytes,Buffer.from(' ')])})).toThrow('exact_paid_scope_approval_required');expect(()=>validateSyntheticAcceptance({...value,readSource:()=>Buffer.from('changed')})).toThrow('approved_runner_changed');expect(()=>validateSyntheticAcceptance({...value,labelsBytes:Buffer.from('changed')})).toThrow('frozen_scope_changed');const root=mkdtempSync(join(tmpdir(),'synthetic-approval-'));try{mkdirSync(join(root,'.context'));const accepted=validateSyntheticAcceptance(value);claimSyntheticAcceptanceDirectory(root,accepted.scope.runId);expect(()=>claimSyntheticAcceptanceDirectory(root,accepted.scope.runId)).toThrow();}finally{rmSync(root,{recursive:true,force:true});}});
it('keeps historical funding restricted to Haiku4.5 and the original25/$1 allowance',()=>{const legacy={scopeVersion:undefined,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0',maxSteps:25,maxCents:100,maxAskSteps:3,stage:undefined,thinking:undefined,pricing:undefined};expect(validateSyntheticAcceptance(input(legacy)).pricing).toMatchObject({inputTokenPriceMicros:1.1,outputTokenPriceMicros:5.5});expect(()=>validateSyntheticAcceptance(input({...legacy,modelVersion:'us.anthropic.claude-sonnet-5-5'}))).toThrow('frozen_scope_changed');});

it('validates the gold-context stage as a distinct allowance and binds the approval reference before dispatch',()=>{expect(validateSyntheticAcceptance(input({stage:'gold_context',maxAskSteps:2,maxSteps:17})).scope.stage).toBe('gold_context');const value=input();const approval=JSON.parse(value.approvalBytes.toString()) as Record<string,unknown>;expect(()=>validateSyntheticAcceptance({...value,approvalBytes:bytes({...approval,reference:'x'.repeat(201)})})).toThrow();});

it('requires a separately bound Sonnet4.6 scope and its stronger-model tariff',()=>{
 const modelVersion='us.anthropic.claude-sonnet-4-6';
 expect(validateSyntheticAcceptance(input({modelVersion})).scope).toMatchObject({modelVersion,stage:'history_investigation',thinking:'disabled'});
 expect(()=>validateSyntheticAcceptance(input({modelVersion,pricing:{inputTokenPriceMicros:1.1,outputTokenPriceMicros:5.5,basis:'conservative_upper_bound_not_invoice'}}))).toThrow('synthetic_price_ceiling_too_low');
 expect(()=>validateSyntheticAcceptance(input({scopeVersion:undefined,modelVersion,maxSteps:25,maxCents:100,maxAskSteps:3,stage:undefined,thinking:undefined,pricing:undefined}))).toThrow('frozen_scope_changed');
});
it('admits only separately approved V2 per-run ten-dollar ceilings while leaving historical funding exact',()=>{
 expect(validateSyntheticAcceptance(input({modelVersion:'us.anthropic.claude-sonnet-4-6',maxCents:1000})).scope.maxCents).toBe(1000);
 expect(()=>validateSyntheticAcceptance(input({maxCents:1001}))).toThrow();
 expect(()=>validateSyntheticAcceptance(input({scopeVersion:undefined,modelVersion:'us.anthropic.claude-haiku-4-5-20251001-v1:0',maxSteps:25,maxCents:1000,maxAskSteps:3,stage:undefined,thinking:undefined,pricing:undefined}))).toThrow('frozen_scope_changed');
});

it('allows an explicitly frozen Ask-only evaluation without an extraction workload or allowance',()=>{
 const askOnly={scopeVersion:3,modelVersion:'us.anthropic.claude-sonnet-4-6',extractionIds:[],maxSteps:37};
 expect(validateSyntheticAcceptance(input(askOnly)).scope.extractionIds).toEqual([]);
 expect(()=>validateSyntheticAcceptance(input({...askOnly,extractionIds:['dev_01']}))).toThrow();
 expect(()=>validateSyntheticAcceptance(input({...askOnly,maxSteps:36}))).toThrow();
});

function inputV4(changes:Record<string,unknown>={}){
 const labelsBytes=readFileSync(new URL('../../../tools/ask-evaluation/fixtures/ask-contract-v4.json',import.meta.url));
 const fixture=JSON.parse(labelsBytes.toString()) as {cases:{id:string;question:string}[]};
 const base=input({scopeVersion:4,modelVersion:'us.anthropic.claude-sonnet-4-6',labelsPath:'tools/ask-evaluation/fixtures/ask-contract-v4.json',labelsSha256:sha(labelsBytes),extractionIds:[],askIds:fixture.cases.map(c=>c.id),askQuestions:Object.fromEntries(fixture.cases.map(c=>[c.id,c.question])),stage:'gold_context',maxAskSteps:2,maxSteps:17,captureNative:true,sourceCommit:'a'.repeat(40),sourceTreeSha256:'b'.repeat(64),...changes});
 return {...base,labelsBytes,sourceTree:{commit:'a'.repeat(40),sha256:'b'.repeat(64)}};
}
it('accepts eight version4 fixtures with exact questions and a frozen whole-source snapshot',()=>{
 const value=inputV4();expect(validateSyntheticAcceptance(value).scope.askIds).toHaveLength(8);
 expect(()=>validateSyntheticAcceptance({...value,sourceTree:{commit:'a'.repeat(40),sha256:'c'.repeat(64)}})).toThrow('approved_runner_changed');
});
it.each([{labelsPath:undefined},{sourceCommit:undefined},{sourceTreeSha256:undefined},{sourceCommit:'c'.repeat(40)},{askIds:['crm2_01']},{askQuestions:{crm2_01:'A different unreviewed question'}},{extractionIds:['dev_01']},{stage:'history_investigation',maxAskSteps:6,maxSteps:49},{maxSteps:16}])('refuses incomplete or changed version4 fixture authority before dispatch (%j)',changes=>{
 expect(()=>validateSyntheticAcceptance(inputV4(changes))).toThrow();
});

function historyInput(changes:Record<string,unknown>={}){
 const source=Buffer.from('frozen source'),labelsBytes=readFileSync(new URL('../../../tools/ask-evaluation/fixtures/ask-history-continuity-v1.json',import.meta.url));
 const labels=JSON.parse(labelsBytes.toString()) as {cases:({id:string;question:string}|{turns:{id:string;question:string}[]})[]};
 const turns=labels.cases.flatMap(item=>'turns' in item?item.turns:[item]);
 const scopeBytes=bytes({scopeVersion:5,captureNative:true,maxRequestInputBytes:30000,maxNativeOutputTokens:4096,maxProbeOutputTokens:32,runId:randomUUID(),modelVersion:'us.anthropic.claude-sonnet-4-6',labelsPath:'tools/ask-evaluation/fixtures/ask-history-continuity-v1.json',labelsSha256:sha(labelsBytes),sourceCommit:'a'.repeat(40),sourceTreeSha256:'b'.repeat(64),extractionIds:[],askIds:turns.map(turn=>turn.id),askQuestions:Object.fromEntries(turns.map(turn=>[turn.id,turn.question])),maxSteps:31,maxCents:1000,maxAskSteps:6,maxAskInputBytes:30000,maxAskOutputTokens:1000,sourceSha256:Object.fromEntries([...SYNTHETIC_ACCEPTANCE_CRITICAL_SOURCES,'apps/api/test/support/syntheticHistoryJourney.ts'].map(path=>[path,sha(source)])),stage:'history_investigation',thinking:'disabled',pricing:{inputTokenPriceMicros:6.6,outputTokenPriceMicros:33,basis:'conservative_upper_bound_not_invoice'},...changes});
 return {scopeBytes,labelsBytes,approvalBytes:bytes({approved:true,approvedBy:'David Cui',scopeSha256:sha(scopeBytes),humanLabelsReviewed:true,reference:'Offline history scope fixture; no spending authority'}),readSource:()=>source,sourceTree:{commit:'a'.repeat(40),sha256:'b'.repeat(64)}};
}
it('binds five history/session questions and their combined six-generation ceiling to a separate exact source approval',()=>{
 expect(validateSyntheticAcceptance(historyInput()).scope).toMatchObject({scopeVersion:5,maxAskSteps:6,maxSteps:31,extractionIds:[],askIds:['history_01','history_02','history_03','continuity_01','continuity_02']});
});
it.each([{maxSteps:30},{maxAskSteps:4},{askIds:['history_01']},{askQuestions:{}},{extractionIds:['history_01']},{labelsPath:'tools/ask-evaluation/fixtures/ask-contract-v4.json'},{sourceSha256:{}},{sourceCommit:undefined},{sourceTreeSha256:undefined}])('refuses an incomplete or expanded history/session grant before dispatch (%j)',changes=>{
 expect(()=>validateSyntheticAcceptance(historyInput(changes))).toThrow();
});
