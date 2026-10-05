import {createHash} from 'node:crypto';
/** The cursor identifies the complete ordering; any mutation restarts cleanly. */
export function paginateToday<T>(cards:readonly T[],scope:string,cursor?:string):{cards:readonly T[];nextCursor:string|null;orderChanged:boolean} {
 const version=createHash('sha256').update(scope).update(JSON.stringify(cards)).digest('hex');
 let offset=0,orderChanged=false;
 if(cursor){const match=/^([a-f0-9]{64}):(\d{1,10})$/u.exec(cursor);if(!match||match[1]!==version||Number(match[2])%50!==0||Number(match[2])>=cards.length)orderChanged=true;else offset=Number(match[2]);}
 return {cards:cards.slice(offset,offset+50),nextCursor:offset+50<cards.length?`${version}:${offset+50}`:null,orderChanged};
}
