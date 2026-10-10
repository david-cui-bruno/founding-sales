import {createHash} from 'node:crypto';
function canonical(value:unknown):unknown {if(Array.isArray(value))return value.map(canonical);if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));return value;}
export function pilotHash(value:unknown):string{return createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))).digest('hex');}
