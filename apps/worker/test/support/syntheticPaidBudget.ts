/** One sequential opt-in acceptance run, shared by extraction and Ask. Unknown calls
 * consume their entire conservative allocation; no automatic provider retry. */
export function syntheticPaidBudget(options:{maxSteps:number;maxCents:number;inputTokenPriceMicros?:number;outputTokenPriceMicros?:number;persist:(snapshot:{startedSteps:number;allocatedCents:number})=>void}){
 const inputPrice=options.inputTokenPriceMicros??1.1,outputPrice=options.outputTokenPriceMicros??5.5;
 if(!Number.isSafeInteger(options.maxSteps)||options.maxSteps<1||options.maxSteps>50||!Number.isSafeInteger(options.maxCents)||options.maxCents<1||options.maxCents>500||!Number.isFinite(inputPrice)||inputPrice<=0||inputPrice>1000||!Number.isFinite(outputPrice)||outputPrice<0||outputPrice>1000)throw new Error('synthetic_budget_configuration_invalid');
 const maxSteps=options.maxSteps,maxCents=options.maxCents;
 let startedSteps=0;let allocatedCents=0;
 return {snapshot:()=>({startedSteps,allocatedCents}),async run<T>(input:unknown,maxOutputTokens:number,call:()=>Promise<T>):Promise<T>{
  // UTF-8 serialized request bytes + fixed protocol overhead conservatively bound
  // text tokens for these text-only English fixtures. Refuse other modalities.
  const bytes=Buffer.byteLength(JSON.stringify(input),'utf8')+2048;
  if(bytes>30000||!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>4096)throw new Error('synthetic_request_bound_exceeded');
  const reserve=Math.ceil((bytes*inputPrice+maxOutputTokens*outputPrice)/10000);
  if(startedSteps>=maxSteps||allocatedCents+reserve>maxCents)throw new Error('synthetic_combined_limit_exceeded');
  startedSteps++;allocatedCents+=reserve;
  // Persist before dispatch. Allocations are never released, including known rejects.
  options.persist({startedSteps,allocatedCents});
  return call();
 }};
}
