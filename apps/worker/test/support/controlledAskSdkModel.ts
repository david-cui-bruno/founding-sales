import {MockLanguageModelV3} from 'ai/test';
export {MockLanguageModelV3};
/** External model fake; actual AI SDK argument/result conversion is exercised. */
export function controlledAskSdkModel(){
 let calls=0;
 const model=new MockLanguageModelV3({doGenerate:async input=>{
  calls++;const ids=[...JSON.stringify(input.prompt).matchAll(/\\"id\\":\\"(w[1-9]\d*|[a-f0-9-]{36})\\"/gu)].map(match=>match[1]!);
  if(!ids[0])throw new Error('fixture_missing_canonical_windows');
  return {content:calls===1?[{type:'tool-call',toolCallId:'native-read',toolName:'read_selected',input:JSON.stringify({windowIds:[ids[0]]})}]:[{type:'text',text:JSON.stringify({claims:[{text:'The original requests faster repairs.',kind:'fact',citationWindowIds:[ids[0]]}],abstained:false})}],finishReason:{unified:calls===1?'tool-calls':'stop',raw:calls===1?'tool_use':'end_turn'},usage:{inputTokens:{total:50,noCache:50,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]};
 }});
 return {model,calls:()=>calls};
}
