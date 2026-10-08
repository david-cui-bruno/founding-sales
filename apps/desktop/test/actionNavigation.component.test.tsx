// @vitest-environment jsdom
import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {useRoute} from '../src/renderer/app/useRoute.ts';

afterEach(()=>{cleanup();vi.unstubAllGlobals();history.replaceState(null,'','#today');});
it('opens a server-revalidated exact action and ignores a click from the previous signed-in session',()=>{
 let deliver:((value:unknown)=>void)|undefined;
 vi.stubGlobal('callie',{onNavigate:()=>{},onActionNavigate:(listener:(value:unknown)=>void)=>{deliver=listener;}});
 const {result,rerender}=renderHook(({generation})=>useRoute(generation),{initialProps:{generation:7}});
 const target={kind:'reply',firmId:'11111111-1111-4111-8111-111111111111',messageId:'22222222-2222-4222-8222-222222222222'};
 expect(deliver).toBeTypeOf('function');
 act(()=>deliver?.({generation:7,target}));
 expect(result.current.route).toEqual({name:'replies',messageId:target.messageId});
 rerender({generation:8});
 act(()=>result.current.navigate({name:'today'}));
 act(()=>deliver?.({generation:7,target}));
 expect(result.current.route).toEqual({name:'today'});
 act(()=>deliver?.({generation:8,target:{kind:'reply',messageId:'https://untrusted.example',firmId:target.firmId}}));
 expect(result.current.route).toEqual({name:'today'});
});
