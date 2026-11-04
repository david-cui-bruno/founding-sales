// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialCalibration} from '../../src/client/BrowserSocialCalibration.tsx';
const json=(value:unknown)=>new Response(JSON.stringify(value));
afterEach(()=>{cleanup();localStorage.clear();vi.unstubAllGlobals();});
it('finds founder drafts beyond an all-manual first page and preserves exact reviewed revisions across later pages through completion',async()=>{
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('navigator',{locks:{request:(_name:string,_options:unknown,work:()=>Promise<unknown>)=>work()}});
 const identity=randomUUID(),firstCursor=randomUUID(),secondCursor=randomUUID(),now=new Date().toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString(),ids=['20100001-0000-4000-8000-000000000001','20100002-0000-4000-8000-000000000002','20100003-0000-4000-8000-000000000003'];
 const revisions=[7,2,3],listBodies:unknown[]=[],finishBodies:unknown[]=[],reviewBodies:unknown[]=[];
 const metadata=(draftId:string,originKind:'manual'|'suggestion')=>({draftId,revision:1,kind:'post',originKind,availability:'available',createdAt:now,updatedAt:now,expiresAt});
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  if(url==='/browser/session')return json({status:'signed_in',workspaceId:identity,userId:identity,deviceId:identity,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt});
  const body=JSON.parse(String(init?.body));
  if(url==='/browser/api/social/calibration/read')return json({completion:null});
  if(url==='/browser/api/social/voice-preferences/read')return json({guide:{state:'absent'}});
  if(url==='/browser/api/social/private-drafts/list'){
   listBodies.push(body);
   if(!body.afterId)return json({drafts:Array.from({length:20},()=>metadata(randomUUID(),'manual')),nextAfterId:firstCursor});
   if(body.afterId===firstCursor)return json({drafts:[metadata(ids[0]!,'suggestion')],nextAfterId:secondCursor});
   if(body.afterId===secondCursor)return json({drafts:ids.slice(1).map(id=>metadata(id,'suggestion')),nextAfterId:null});
   throw Error('Unexpected cursor');
  }
  if(url==='/browser/api/social/private-drafts/read'){
   reviewBodies.push(body);const index=ids.indexOf(body.draftId);if(index<0)throw Error('Unexpected draft');
   return json({draft:{...metadata(body.draftId,'suggestion'),revision:revisions[index],availability:'available',text:`Fictional personally reviewed calibration draft ${index+1}.`,origin:{kind:'suggestion',requestId:randomUUID(),conceptIndex:0,variantIndex:0,selectionSHA256:'a'.repeat(64)},reviewRequired:true}});
  }
  if(url==='/browser/api/social/calibration/finish'){finishBodies.push(body);return json({status:'accepted',replayed:false,result:{calibrationId:randomUUID(),completedAt:now,guideRef:null}});}
  throw Error('Unexpected route');
 });
 const client=new BrowserClient({storage:localStorage,fetch,navigate:vi.fn(),randomUUID});await client.refresh();const completed=vi.fn();
 try{
  render(<BrowserSocialCalibration client={client} onCompleted={completed}/>);fireEvent.click(screen.getByRole('button',{name:'Read calibration and private examples'}));
  await screen.findByRole('button',{name:'Next private drafts page'});expect(screen.queryByRole('button',{name:/Review current draft/u})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Next private drafts page'}));await screen.findByRole('button',{name:'Review current draft 20100001'});fireEvent.click(screen.getByRole('button',{name:'Review current draft 20100001'}));await screen.findByText('Exact revision 7');
  fireEvent.click(screen.getByRole('button',{name:'Next private drafts page'}));await screen.findByRole('button',{name:'Review current draft 20100002'});expect(screen.getByText('Exact revision 7')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Review current draft 20100002'}));await screen.findByText('Exact revision 2');fireEvent.click(screen.getByRole('button',{name:'Review current draft 20100003'}));await screen.findByText('Exact revision 3');
  expect(screen.getByText('Exact revision 7')).toBeTruthy();expect(screen.queryByRole('button',{name:'Next private drafts page'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Accept voice, facts and willingness for these exact three revisions'}));await waitFor(()=>expect(completed).toHaveBeenCalledOnce());
  expect(listBodies).toEqual([{}, {afterId:firstCursor},{afterId:secondCursor}]);expect(reviewBodies).toEqual(ids.map(draftId=>({draftId})));
  expect(finishBodies).toEqual([{examples:ids.map((draftId,index)=>({draftId,revision:revisions[index]})),expectedGuide:null,commandId:expect.any(String)}]);
 }finally{client.dispose();}
});
