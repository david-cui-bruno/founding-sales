/** One sequential opt-in acceptance run, shared by extraction and Ask. Unknown calls
 * consume their entire conservative allocation; no automatic provider retry. */
export function syntheticPaidBudget(options:{maxSteps:number;maxCents:number;persist:(snapshot:{startedSteps:number;allocatedCents:number})=>void}){
 let startedSteps=0;let allocatedCents=0;
 return {snapshot:()=>({startedSteps,allocatedCents}),async run<T>(input:unknown,maxOutputTokens:number,call:()=>Promise<T>):Promise<T>{
  // UTF-8 serialized request bytes + fixed protocol overhead conservatively bound
  // text tokens for these text-only English fixtures. Refuse other modalities.
  const bytes=Buffer.byteLength(JSON.stringify(input),'utf8')+2048;
  if(bytes>30000||!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>4096)throw new Error('synthetic_request_bound_exceeded');
  const reserve=Math.ceil((bytes*1.1+maxOutputTokens*5.5)/10000);
  if(startedSteps>=options.maxSteps||allocatedCents+reserve>options.maxCents)throw new Error('synthetic_combined_limit_exceeded');
  startedSteps++;allocatedCents+=reserve;
  // Persist before dispatch. Allocations are never released, including known rejects.
  options.persist({startedSteps,allocatedCents});
  return call();
 }};
}
