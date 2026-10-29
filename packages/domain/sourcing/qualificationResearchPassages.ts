import {qualificationEvidenceSchema,sourcingUrlSchema,type QualificationFact,type SourceObservation} from '@fss/contracts';
export interface ResearchPassage {kind:'phone'|'person'|'location';observationId:string;sourceUrl:string;retrievedAt:string;blocks:{id:string;text:string}[]}
type Input={companyName:string;website:string;observations:readonly SourceObservation[];facts:readonly QualificationFact[]};
const fold=(text:string)=>text.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const phone=/(?<![\p{L}\d])(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}(?![\p{L}\d])/u;
const namedLeader=/(?:\b(?:[Oo]wner|[Cc]o-owner|[Ff]ounder|[Pp]resident|CEO|[Mm]anaging [Dd]irector)\s*[:,–—-]?\s+[\p{Lu}][\p{L}’'-]+(?:\s+[\p{Lu}][\p{L}’'-]+){1,2}\b|\b[\p{Lu}][\p{L}’'-]+(?:\s+[\p{Lu}][\p{L}’'-]+){1,2}\s*[,–—-]\s*(?:[Oo]wner|[Cc]o-owner|[Ff]ounder|[Pp]resident|CEO|[Mm]anaging [Dd]irector)\b)/u;
const leaderCard=new RegExp(`^(?:${namedLeader.source})[.!]?$`,'u');
const street=/\b\d{1,6}\s+(?:[\p{L}\d.'-]+\s+){1,7}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|parkway|pkwy|place|pl|terrace|ter|circle|cir)\b/iu;
const office=/\b[A-Z]{2}\s+[Oo]ffice\b|\b[Oo]ffice(?: address| location)?\s*:/u;
const excluded=/\b(?:testimonial|customer review|website by|powered by|web design|fax|emergency|after.hours)\b/iu;
function host(url:string):string|null {if(url!==url.trim()||!sourcingUrlSchema.safeParse(url).success)return null;return new URL(url).hostname.toLowerCase().replace(/^www\./u,'');}
/** Dated original research passages only. This pure presentation helper grants no
 * source/identity/phone/Person authority; the read owner controls retained access. */
export function qualificationResearchPassages(input:Input):{passages:ResearchPassage[];hasMore:boolean}{
 const empty={passages:[],hasMore:true};
 if(!input||typeof input.companyName!=='string'||input.companyName.trim().length<2||input.companyName.length>300||typeof input.website!=='string'||input.website.length>500||!Array.isArray(input.observations)||input.observations.length>8||!Array.isArray(input.facts)||input.facts.length>30)return empty;
 const observations:readonly SourceObservation[]=input.observations,facts:readonly QualificationFact[]=input.facts;
 if(observations.some(s=>!s||!Array.isArray(s.blocks)||s.blocks.length>100)||!qualificationEvidenceSchema.safeParse({observations:input.observations,facts:input.facts}).success)return empty;
 const companyHost=host(input.website);if(!companyHost)return empty;
 const passages:ResearchPassage[]=[];let hasMore=false;
 for(const source of observations){
  if(!source.firstParty||source.truncated||host(source.url)!==companyHost){hasMore=true;continue;}
  for(const fact of facts){
   if(fact.kind!=='business_phone'||fact.observationId!==source.id)continue;
   const index=source.blocks.findIndex(b=>b.id===fact.blockId&&b.text===fact.value);
   if(index<0||!phone.test(fact.value)||excluded.test(fact.value)){hasMore=true;continue;}
   let start=index;
   for(let i=Math.max(0,index-4);i<=index;i++)if(fold(source.blocks[i]!.text).includes(fold(input.companyName))){start=i;break;}
   const blocks=source.blocks.slice(start,index+1);
   if(blocks.some(b=>b.text.length>2000)||blocks.reduce((n,b)=>n+b.text.length,0)>5000){hasMore=true;continue;}
   if(passages.some(p=>p.kind==='phone'&&p.observationId===source.id&&p.blocks[0]?.id===blocks[0]?.id&&p.blocks.at(-1)?.id===blocks.at(-1)?.id))continue;
   if(passages.length===12){hasMore=true;continue;}
   passages.push({kind:'phone',observationId:source.id,sourceUrl:source.url,retrievedAt:source.retrievedAt,blocks:blocks.map(b=>({id:b.id,text:b.text}))});
  }
  for(const [index,block] of source.blocks.entries()){
   if(!namedLeader.test(block.text))continue;
   if(!fold(block.text).includes(fold(input.companyName))&&!leaderCard.test(block.text.trim())){hasMore=true;continue;}
   let start=index;for(let i=index;i>=Math.max(0,index-4);i--)if(fold(source.blocks[i]!.text).includes(fold(input.companyName))){start=i;break;}
   const blocks=source.blocks.slice(start,index+1);
   if(!blocks.some(b=>fold(b.text).includes(fold(input.companyName)))||blocks.some(b=>excluded.test(b.text)||/\b(?:customer|testimonial|landlord|property owner|national|nationwide|franchise network|former|retired)\b|\b(?:19|20)\d{2}\b/iu.test(b.text))||blocks.some(b=>b.text.length>2000)||blocks.reduce((n,b)=>n+b.text.length,0)>5000||passages.length===12){hasMore=true;continue;}
   passages.push({kind:'person',observationId:source.id,sourceUrl:source.url,retrievedAt:source.retrievedAt,blocks:blocks.map(b=>({id:b.id,text:b.text}))});
  }
  for(const [index,block] of source.blocks.entries()){
   if(!street.test(block.text)&&!office.test(block.text))continue;
   let start=index;for(let i=index;i>=Math.max(0,index-4);i--)if(fold(source.blocks[i]!.text).includes(fold(input.companyName))){start=i;break;}
   const end=street.test(source.blocks[index+1]?.text??'')?index+1:index,blocks=source.blocks.slice(start,end+1);
   if(!blocks.some(b=>fold(b.text).includes(fold(input.companyName)))||blocks.length>5||blocks.some(b=>excluded.test(b.text)||b.text.length>2000)||blocks.reduce((n,b)=>n+b.text.length,0)>5000){hasMore=true;continue;}
   if(passages.some(p=>p.kind==='location'&&p.observationId===source.id&&p.blocks[0]?.id===blocks[0]?.id&&p.blocks.at(-1)?.id===blocks.at(-1)?.id))continue;
   if(passages.length===12){hasMore=true;continue;}
   passages.push({kind:'location',observationId:source.id,sourceUrl:source.url,retrievedAt:source.retrievedAt,blocks:blocks.map(b=>({id:b.id,text:b.text}))});
  }
 }
 return {passages,hasMore};
}
