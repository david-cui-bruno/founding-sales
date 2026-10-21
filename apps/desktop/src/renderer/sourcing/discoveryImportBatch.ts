import {discoveryIntakeSaveInputSchema,discoverySourceKey,type DiscoveryIntakeSaveInput} from '@fss/contracts';
import type {OperationInput} from '../../shared/operations.ts';

export const DISCOVERY_FILE_BYTES=10_000_000;
export const DISCOVERY_FILE_ROWS=2000;
export type DiscoveryCommand=OperationInput<'sourcing.discoverySave'>;
export interface DiscoveryBatch {
  readonly digest:string;
  readonly commands:readonly DiscoveryCommand[];
  readonly unknownWebsites:number;
  readonly observations:number;
  readonly noticeReferences:number;
  readonly contractNameTrims:number;
}
/** Compare JSON values without changing any string, source URL, unknown or array order. */
export function exactJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(exactJson).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${exactJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function requireCurrent(current:()=>boolean):void {
  if(!current())throw new Error('session_changed');
}
function freeze<T>(value:T):T {
  if(value!==null&&typeof value==='object') {for(const item of Object.values(value))freeze(item);Object.freeze(value);}
  return value;
}
async function digest(text:string,current:()=>boolean):Promise<string> {
  requireCurrent(current);
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  requireCurrent(current);
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Every entry is validated before any command. Only the existing contract name trim is allowed. */
export async function prepareDiscoveryBatch(text:string,current:()=>boolean=()=>true):Promise<DiscoveryBatch> {
  requireCurrent(current);
  if(new TextEncoder().encode(text).length>DISCOVERY_FILE_BYTES)throw new Error('file_too_large');
  let raw:unknown;
  try{raw=JSON.parse(text);}catch{throw new Error('invalid_json');}
  if(!Array.isArray(raw)||raw.length===0||raw.length>DISCOVERY_FILE_ROWS)throw new Error('invalid_row_count');
  const rows:DiscoveryIntakeSaveInput[]=[],seen=new Set<string>();let contractNameTrims=0;
  for(const entry of raw){
    requireCurrent(current);
    const parsed=discoveryIntakeSaveInputSchema.safeParse(entry);
    // Raw import is never an attachment/merge action. Preserve every non-name value.
    if(!parsed.success||parsed.data.attachTo!==undefined||Object.keys(entry as object).length!==2)throw new Error('invalid_entry');
    const original=entry as DiscoveryIntakeSaveInput;
    const allowed={...original,row:{...original.row,firmName:original.row.firmName.trim()}};
    if(exactJson(parsed.data)!==exactJson(allowed))throw new Error('unexpected_transformation');
    if(original.row.firmName!==parsed.data.row.firmName)contractNameTrims++;
    for(const source of parsed.data.row.observations){
      const key=discoverySourceKey(source);
      if(seen.has(key))throw new Error('duplicate_source_tuple');
      seen.add(key);
    }
    rows.push(parsed.data);
  }
  // File bytes (valid UTF-8 text), including original name whitespace, bind a resume.
  const batchDigest=await digest(text,current),commands:DiscoveryCommand[]=[];
  for(const entry of rows){
    const id=await digest(exactJson([batchDigest,discoverySourceKey(entry.row.source)]),current);
    requireCurrent(current);
    commands.push({...entry,commandId:`discovery126:${id}`});
  }
  return freeze({digest:batchDigest,commands,contractNameTrims,unknownWebsites:rows.filter(entry=>entry.row.website===null).length,observations:seen.size,noticeReferences:rows.reduce((sum,entry)=>sum+entry.origins.reduce((count,origin)=>count+origin.notices.length,0),0)});
}
