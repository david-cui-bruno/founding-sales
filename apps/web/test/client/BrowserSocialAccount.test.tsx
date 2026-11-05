// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialAccount} from '../../src/client/BrowserSocialAccount.tsx';
const id='10000000-0000-4000-8000-000000000001';
const clients:BrowserClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());});
it('reopens the saved exact publishing identity without entering a key or contacting the publisher',async()=>{
 const binding={adapter:'buffer-linkedin-v1',workspaceId:id,ownerUserId:id,accountId:id,accountRevision:1,credentialId:id,credentialRevision:1,organizationId:'a'.repeat(24),channelId:'b'.repeat(24),externalId:'selected-owner-native-id'};
 const fetcher=vi.fn<typeof fetch>(async input=>{
  const path=String(input);
  if(path.endsWith('/social/standing-plan/options'))return Response.json({binding,accountDisplayName:'Selected personal owner',intendedAccountId:id,calibrationId:id,guideRef:null,inputIds:[id]});
  if(path.includes('/browser/api/'))throw Error('Unexpected publisher or command request');
  return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()});
 });
 const storage={getItem:vi.fn(()=>null),setItem:vi.fn(),removeItem:vi.fn()};
 const client=new BrowserClient({storage,navigate:vi.fn(),fetch:fetcher,randomUUID:()=>id});clients.push(client);await client.refresh();
 const review=vi.fn();let view=render(<BrowserSocialAccount client={client} onReviewPlan={review}/>);
 for(let opening=0;opening<2;opening++){
  const profile=within(await screen.findByRole('region',{name:'Saved Buffer connection'}));
  expect(profile.getByRole('heading',{name:'Selected personal owner'})).toBeTruthy();expect(profile.getByText(binding.externalId)).toBeTruthy();
  expect(screen.getByLabelText('Buffer API key')).toHaveProperty('value','');expect(screen.queryByRole('radio')).toBeNull();expect(review).not.toHaveBeenCalled();
  if(opening===0){view.unmount();view=render(<BrowserSocialAccount client={client} onReviewPlan={review}/>);}
 }
 expect(fetcher.mock.calls.filter(([input])=>String(input).includes('/browser/api/')).map(([input])=>String(input))).toEqual(['/browser/api/social/standing-plan/options','/browser/api/social/standing-plan/options']);
 expect(storage.setItem).not.toHaveBeenCalled();
});
