import {expect,it} from 'vitest';
import {paginateToday} from '../../today/pagination.ts';
it('returns every card once in pages of fifty and resets a changed order',()=>{
 const cards=Array.from({length:121},(_,n)=>({firmId:String(n),lane:'new_firm',dueAt:'2026-10-05T00:00:00Z'}));
 const first=paginateToday(cards,'version:date:user');expect(first.cards).toHaveLength(50);
 const second=paginateToday(cards,'version:date:user',first.nextCursor!);const third=paginateToday(cards,'version:date:user',second.nextCursor!);
 expect([...first.cards,...second.cards,...third.cards]).toEqual(cards);expect(third.nextCursor).toBeNull();
 const changed=paginateToday([...cards].reverse(),'version:date:user',first.nextCursor!);expect(changed.orderChanged).toBe(true);expect(changed.cards[0]).toEqual(cards.at(-1));
 expect(paginateToday(cards,'new-version:date:user',first.nextCursor!).orderChanged).toBe(true);
 expect(paginateToday(cards,'version:date:user','invalid').orderChanged).toBe(true);
});
