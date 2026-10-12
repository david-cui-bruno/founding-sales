// Diagnostic only. Fake credentials and intercepted fetch; no external calls.
import {createAmazonBedrock} from '../../../apps/worker/node_modules/@ai-sdk/amazon-bedrock/dist/index.js';
import {createAskSdkStepAdapter} from '../../../apps/worker/src/providers/askAgentSdk.ts';
// Synthetic SDK-returned candidate from grant15; native Converse envelope below is reconstructed.
const candidate={"abstained": false, "claims": [{"citationWindowIds": ["w1"], "kind": "fact", "text": "The note reports that the old plan has been explicitly rejected ("}, {"citationWindowIds": ["w1"], "kind": "fact", "text": "The note reports that the old plan is explicitly rejected ("}, {"citationWindowIds": ["w1"], "kind": "inference", "text": "The note reports two distinct elements: an authored statement that 'That old plan is no longer valid' (rejecting the old plan), and a quoted 2025 message stating 'I will send the contract Friday.' The contract promise appears to be a historical quotation from 2025 embedded within a newer note, while the rejection of the old plan is presented as current, newly authored text. Whether the contract was ultimately sent is not evidenced in the available sources."}]};
const mode=process.argv[2]??'captured';
const value=mode==='escaped'?{claims:[{...candidate.claims[0],text:"The note says “repairs”, \"quoted\" text, and C:\\plans."}],abstained:false}:mode==='minimal'?{claims:[candidate.claims[0]],abstained:false}:mode==='control'?{claims:[{...candidate.claims[0],text:'The note reports that the old plan was rejected.'}],abstained:false}:candidate;
let calls=0;let strict;let choice;
const provider=createAmazonBedrock({region:'us-east-1',accessKeyId:'controlled-fixture',secretAccessKey:'controlled-fixture',fetch:async(_url,options)=>{
 calls++; const body=JSON.parse(String(options?.body));strict=body.toolConfig.tools[0].toolSpec.strict;choice=body.toolConfig.toolChoice.tool.name;
 return new Response(JSON.stringify({output:{message:{role:'assistant',content:[{toolUse:{toolUseId:'captured-finish',name:'emit_answer',input:value}}]}},stopReason:'tool_use',usage:{inputTokens:100,outputTokens:50,totalTokens:150},metrics:{latencyMs:1}}),{headers:{'content-type':'application/json'}});
}});
const adapter=createAskSdkStepAdapter({region:'us-east-1',endpointId:'bedrock-runtime.us-east-1.amazonaws.com',modelVersion:'us.anthropic.claude-sonnet-4-6',providerKey:'controlled-replay',model:provider('us.anthropic.claude-sonnet-4-6')});
const result=await adapter.runStep({question:'Is the contract promise historical?',transcript:[{windows:[{id:'11111111-1111-4111-8111-111111111111',ordinal:1,source:{kind:'selected_note'},text:'That old plan is no longer valid. Quoted 2025: I will send the contract Friday.'}]}],maxOutputTokens:1000,remainingSteps:1,signal:new AbortController().signal});
const answer=result.answer;
const preserved=answer!==null&&answer.claims.every((claim,index)=>claim.text===value.claims[index].text);
const fragments=answer?.claims.filter((claim)=>claim.text===candidate.claims[0].text||claim.text===candidate.claims[1].text).length??0;
console.log(JSON.stringify({mode,network:'fake transport only',calls,acceptance:result.acceptance,usage:result.usage,strict,choice,textPreserved:preserved,unfinishedClaims:fragments}));
if(calls!==1||result.acceptance!=='accepted'||!preserved)process.exit(2);
if(fragments>0)process.exit(1);
