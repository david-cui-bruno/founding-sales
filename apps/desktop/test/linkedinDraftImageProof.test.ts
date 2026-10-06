/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {webcrypto,createHash} from 'node:crypto';
import {linkedInDraftImageProofScript} from '../src/main/social/adapters/linkedinDraftImageProof.ts';
afterEach(()=>{document.body.innerHTML='';});
const source='blob:https://www.linkedin.com/b0791b68-081f-4d5a-b559-b82eae4ca37f';
function setup(src=source){document.body.innerHTML=`<dialog open data-testid="dialog"><div componentkey="ShareBox_textEditor"></div><img src="${src}" alt="Test image"></dialog>`;}
async function run(fetcher:unknown){return new Function('document','window','fetch','crypto','AbortSignal',`return ${linkedInDraftImageProofScript()}`)(document,window,fetcher,webcrypto,AbortSignal);}
it('hashes the actual draft blob rather than copying an expected hash',async()=>{setup();const bytes=new Uint8Array([1,2,3]);const fetcher=vi.fn(async(_url:string,_options:unknown)=>new Response(bytes));expect(await run(fetcher)).toEqual({ok:true,view:{sha256:createHash('sha256').update(bytes).digest('hex'),altText:'Test image',bytes:3}});expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]?.[0]).toBe(source);});
it.each(['https://media.licdn.com/image.png','blob:https://evil.test/image','data:image/png;base64,AA=='])('refuses non-local-draft sources: %s',async src=>{setup(src);const fetcher=vi.fn();expect(await run(fetcher)).toEqual({ok:false});expect(fetcher).not.toHaveBeenCalled();});
it('refuses ambiguous media before fetching',async()=>{setup();document.querySelector('dialog')!.append(document.querySelector('img')!.cloneNode());const fetcher=vi.fn();expect(await run(fetcher)).toEqual({ok:false});expect(fetcher).not.toHaveBeenCalled();});
it('refuses changed media during the read',async()=>{setup();expect(await run(async()=>{document.querySelector('img')!.setAttribute('alt','Changed');return new Response(new Uint8Array([1]));})).toEqual({ok:false});});
it('refuses oversized or empty blobs',async()=>{setup();expect(await run(async()=>new Response(new Uint8Array(5*1024*1024+1)))).toEqual({ok:false});expect(await run(async()=>new Response(new Uint8Array()))).toEqual({ok:false});});
