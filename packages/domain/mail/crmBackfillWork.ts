import {createHash} from 'node:crypto';
import type {BackfillAuthority} from './crmBackfillAuthority.ts';
import type {BackfillAllocation} from './crmBackfillBudget.ts';
export interface BackfillSliceHint{ordinal:number;next_page_token:string|null}
/** Body-free exact hint fingerprints, not verification or a grant to read. */
export function backfillAttemptHashes(authority:BackfillAuthority,allocation:BackfillAllocation,slice:BackfillSliceHint|undefined){
 const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 return {attemptConfigurationHash:hash({proof:authority.proof,allocation}),attemptProgressHash:hash({from:authority.fromEpochMicroseconds,to:authority.toEpochMicroseconds,anchor:authority.historyAnchor,cursor:authority.historyCursor,ordinal:slice?.ordinal??null,tokenHash:slice?.next_page_token===undefined||slice.next_page_token===null?null:hash(slice.next_page_token)})};
}
export function backfillWorkKey(hashes:{attemptConfigurationHash:string;attemptProgressHash:string}){
 return `crm-mail-backfill:${createHash('sha256').update(JSON.stringify(hashes)).digest('hex')}`;
}
