// @vitest-environment jsdom
import {afterEach,it,expect} from 'vitest';
import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {QueuePanel} from '../src/renderer/today/QueuePanel.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import type {TodayCard} from '../src/renderer/todayContract.ts';
afterEach(cleanup);
it('shows fifty queue rows at a time and reaches the selected firm after keyboard navigation',()=>{
 const cards:TodayCard[]=Array.from({length:121},(_,n)=>({firmId:`id-${n}`,firmName:`PM ${n}`,lane:'new_firm',dueAt:'2026-10-05T00:00:00Z',counts:{replies:0,emailsDue:0,callsDue:0},blockers:[]}));
 const props={cards,selected:null,done:new Set<string>(),locked:false,scrollTop:0,onScroll:()=>{},onSelect:()=>{}};
 const {rerender}=render(<DraftsProvider><QueuePanel {...props}/></DraftsProvider>);
 expect(screen.getAllByTestId('queue-row')).toHaveLength(50);
 fireEvent.click(screen.getByRole('button',{name:'Next queue page'}));expect(screen.getByText('PM 50')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Next queue page'}));expect(screen.getAllByTestId('queue-row')).toHaveLength(21);
 rerender(<DraftsProvider><QueuePanel {...props} selected="id-3"/></DraftsProvider>);expect(screen.getByText('PM 3')).toBeTruthy();
});
