import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import {loadBedrockTransport} from '@fss/domain/classification/bedrockClient.ts';
import {bedrockModelRoute,readModelTransport} from '@fss/domain/classification/modelTransport.ts';
import {routedTransport} from '@fss/domain/classification/routedTransport.ts';
import {humanReplyDraftInterpretation} from '@fss/domain/replies/composerModel.ts';
import type {HumanReplyDraftPort} from '@fss/domain/replies/composerGeneration.ts';

/** Composition only: no new credential, IAM permission, fallback or default budget. */
export async function loadHumanReplyDraftPort(environment:Readonly<Record<string,string|undefined>>,load:(options:{region:string})=>Promise<AnthropicMessagesTransport>=loadBedrockTransport):Promise<HumanReplyDraftPort|null>{
 const region=(environment['AWS_REGION']??'').trim();
 if(readModelTransport(environment).kind!=='bedrock'||region==='')return null;
 try{return humanReplyDraftInterpretation(routedTransport({route:bedrockModelRoute({directAvailable:false}),bedrock:await load({region}),anthropic:null}));}
 catch{return null;}
}
