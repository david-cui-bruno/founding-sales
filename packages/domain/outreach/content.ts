import {createHash} from 'node:crypto';
import {hasOptOutLink,type AnswerBlock} from '@fss/contracts';
import type {ReplyDecision} from './replyPolicy.ts';
export function renderRoutineReply(input:{decision:ReplyDecision;blocks:readonly AnswerBlock[];template:{subject:string;opening:string;signOff:string};bookingUrl:string|null}):{ok:true;value:{subject:string;body:string;contentHash:string}}|{ok:false;reason:string}{
 if(input.decision.kind!=='answer')return {ok:false,reason:'not_an_answer'};
 const selected:AnswerBlock[]=[];
 for(const ref of input.decision.blockRefs){const block=input.blocks.find(b=>b.id===ref.id&&b.version===ref.version);if(!block||block.approvedAt===null||block.retiredAt!==null)return {ok:false,reason:'block_unavailable'};selected.push(block);}
 if(!selected.length||new Set(selected.map(b=>b.id)).size!==selected.length)return {ok:false,reason:'invalid_blocks'};
 const texts:string[]=[];
 for(const block of selected){
  if(block.kind==='booking'&&block.text.includes('{booking_url}')){
   let url:URL;try{url=new URL(input.bookingUrl??'');}catch{return {ok:false,reason:'booking_link_unavailable'};}
   if(url.protocol!=='https:'||url.hostname!=='cal.com'||url.username||url.password)return {ok:false,reason:'booking_link_unavailable'};
   texts.push(block.text.replaceAll('{booking_url}',url.toString()));
  }else texts.push(block.text);
 }
 const subject=input.template.subject.trim(),body=[input.template.opening.trim(),...texts,input.template.signOff.trim()].filter(Boolean).join('\n\n');
 if(!subject||!input.template.signOff.trim()||/[\r\n]/.test(subject)||hasOptOutLink(subject)||hasOptOutLink(body))return {ok:false,reason:'template_invalid'};
 return {ok:true,value:{subject,body,contentHash:createHash('sha256').update(JSON.stringify({subject,body})).digest('hex')}};
}
