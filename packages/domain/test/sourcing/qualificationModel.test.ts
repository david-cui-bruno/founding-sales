import {expect,it} from 'vitest';
import {GEMINI_STANDARD_PRICE_FROM,QUALIFICATION_MODEL_NAME,QUALIFICATION_PROVIDER_KEY,UnpricedQualificationModelError,isPricedQualificationModel,qualificationCents} from '../../sourcing/qualificationModel.ts';
import {CREDIT_FUNDED_PROVIDER_KINDS,providerFunding} from '../../settings/funding.ts';
import {isCreditModelProvider} from '../../research/modelBudget.ts';
import {PRICE_CENTS_PER_MILLION,isPricedModel} from '../../research/pricing.ts';

const intro='2026-11-01T12:00:00.000Z',standard='2027-01-01T00:00:00.000Z';
it('names its own model and provider, and funds the provider from credits under the credit-model cap',()=>{
 expect(QUALIFICATION_MODEL_NAME).toBe('gemini-3.8-flash');
 expect(QUALIFICATION_PROVIDER_KEY).toBe('google_vertex.sourcing_qualification');
 expect(providerFunding(QUALIFICATION_PROVIDER_KEY)).toBe('credits');
 expect(CREDIT_FUNDED_PROVIDER_KINDS).toContain('google_vertex');
 expect(isCreditModelProvider(QUALIFICATION_PROVIDER_KEY)).toBe(true);
 // Research extraction keeps its single Claude model and price table: Gemini is not admitted there.
 expect(Object.keys(PRICE_CENTS_PER_MILLION)).toEqual(['claude-haiku-4-5']);
 expect(isPricedModel(QUALIFICATION_MODEL_NAME,'bedrock')).toBe(false);
});
it('prices only gemini-3.8-flash and refuses every other model',()=>{
 expect(isPricedQualificationModel('gemini-3.8-flash')).toBe(true);
 for(const model of ['claude-haiku-4-5','gemini-3.8-flash-lite','gemini-3.5-flash',''])expect(isPricedQualificationModel(model)).toBe(false);
 expect(()=>qualificationCents('claude-haiku-4-5',{inputTokens:1,outputTokens:1},intro)).toThrow(UnpricedQualificationModelError);
});
it('rounds up to whole cents at the introductory price through 31 December 2026: $0.75 in, $3.75 out per million',()=>{
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:1_000_000,outputTokens:0},intro)).toBe(75);
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:0,outputTokens:1_000_000},intro)).toBe(375);
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:30_000,outputTokens:1_200},intro)).toBe(Math.ceil((30_000*75+1_200*375)/1_000_000));
 // A call that happened costs a cent; nothing costs nothing.
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:1,outputTokens:1},intro)).toBe(1);
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:0,outputTokens:0},intro)).toBe(0);
});
it('doubles to $1.50 in / $7.50 out per million from 1 January 2027, on the instant the table says',()=>{
 expect(GEMINI_STANDARD_PRICE_FROM).toBe(standard);
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:1_000_000,outputTokens:1_000_000},'2026-12-31T23:59:59.999Z')).toBe(450);
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:1_000_000,outputTokens:1_000_000},standard)).toBe(900);
});
it('truncates fractions, floors negatives at zero and refuses a count that is not a number',()=>{
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:-5,outputTokens:0},intro)).toBe(0);
 expect(()=>qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:1,outputTokens:Number.NaN},intro)).toThrow(RangeError);
 expect(qualificationCents(QUALIFICATION_MODEL_NAME,{inputTokens:0.9,outputTokens:1_000_000},intro)).toBe(375);
});
