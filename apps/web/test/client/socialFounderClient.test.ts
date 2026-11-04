import {describe,expect,it,vi} from 'vitest';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
const id='00000000-0000-4000-8000-000000000001';
const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'social-current',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120_000).toISOString()};
const json=(body:unknown)=>new Response(JSON.stringify(body));
function fixture(fetch:typeof globalThis.fetch){const values=new Map<string,string>();return new BrowserClient({fetch,storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);},removeItem:key=>{values.delete(key);}},navigate:vi.fn(),randomUUID:()=>id});}
describe('founder browser consumer contracts',()=>{
 it('reads source eligibility through exact signed routes and rejects extra response material',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json({inputs:[],nextAfterId:null})).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json({completion:null,privateExamples:'not allowed'}));
  const client=fixture(fetch);await client.refresh();
  await expect(client.socialFounderInputs()).resolves.toEqual({inputs:[],nextAfterId:null});
  expect(fetch.mock.calls[2]).toMatchObject(['/browser/api/social/inputs/list',{method:'POST',credentials:'same-origin',body:'{}'}]);
  await expect(client.socialCalibration()).rejects.toMatchObject({reason:'invalid_response'});client.dispose();
 });
 it('does not project owner-private input text after an identity transition during response JSON',async()=>{
  const {promise:waiting,resolve:finish}=Promise.withResolvers<unknown>();
  const answer=json(null);answer.json=async()=>waiting;
  const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(answer);
  const client=fixture(fetch);await client.refresh();const work=client.socialFounderInput({inputId:id});
  const rejected=expect(work).rejects.toMatchObject({reason:'session_changed'});
  await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(3));client.invalidate();
  finish({input:{state:'available',inputId:id,revision:1,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString(),bullets:'Old owner private update',context:'',experienceDate:null,publicSafe:true}});
  await rejected;client.dispose();
 });
 it('reconciles only opaque command identity without replaying input or guide text',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json(session)).mockResolvedValueOnce(json({state:'unknown'}));
  const client=fixture(fetch);await client.refresh();
  await expect(client.socialFounderReceipt({kind:'input',commandId:id,payloadSHA256:'a'.repeat(64)})).resolves.toEqual({state:'unknown'});
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({kind:'input',commandId:id,payloadSHA256:'a'.repeat(64)});client.dispose();
 });
});
