import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
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
