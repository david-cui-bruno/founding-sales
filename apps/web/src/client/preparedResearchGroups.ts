import type {PreparedProspectSummary} from '@fss/contracts';

function matchingMetadata(row:PreparedProspectSummary):string|null {
 if(!row.website)return null;
 try{
  const url=new URL(row.website);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;
 }catch{return null;}
 // Exact discovery metadata only. Do not normalize paths, infer a company or
 // combine branch/profile hints. Nonadjacent records keep their original order.
 return JSON.stringify([row.website,row.targetingLocality,row.targetingRegion]);
}

export function groupAdjacentPreparedRecords(rows:readonly PreparedProspectSummary[]):PreparedProspectSummary[][] {
 const groups:PreparedProspectSummary[][]=[];let previous:string|null=null;
 for(const row of rows){
  const key=matchingMetadata(row);
  if(key!==null&&key===previous)groups[groups.length-1]!.push(row);
  else groups.push([row]);
  previous=key;
 }
 return groups;
}
