// @vitest-environment jsdom
import {webcrypto,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {ManualProspectActivityCustody,MANUAL_ACTIVITY_PENDING_KEY} from '../../src/client/ManualProspectActivityCustody.ts';
const input=()=>({operation:'create' as const,candidateId:randomUUID(),expectedCandidateRevision:1,attemptId:randomUUID(),performedByUser:true as const,channel:'manual_phone' as const,occurrence:{kind:'unknown' as const},result:'unknown' as const,note:'Private prose never persisted',callback:null});
function setup(){
 vi.stubGlobal('crypto',webcrypto);const bytes=new Map<string,string>(),storage={getItem:(key:string)=>bytes.get(key)??null,setItem:(key:string,value:string)=>{bytes.set(key,value);},removeItem:(key:string)=>{bytes.delete(key);}};
 let binding:{identity:string;expiresAt:string}|null={identity:'workspace:user:device:session',expiresAt:new Date(Date.now()+60000).toISOString()};const uuid=vi.fn(randomUUID),custody=new ManualProspectActivityCustody(storage,()=>binding,uuid);
 return {custody,storage,bytes,uuid,change:(value:typeof binding)=>{binding=value;}};
}
afterEach(()=>vi.unstubAllGlobals());
it('persists only opaque IDs/hash, reloads exact UUID and never remints unknown custody',async()=>{
 const f=setup(),payload=input(),held=await f.custody.prepare(payload,()=>true),raw=f.storage.getItem(MANUAL_ACTIVITY_PENDING_KEY)!;
 expect(raw).not.toContain(payload.note);expect(raw).not.toContain('performedByUser');expect(raw).not.toContain('manual_phone');expect(raw).not.toContain('occurrence');expect(raw).not.toContain('unknown');expect(held.payloadSHA256).toMatch(/^[a-f0-9]{64}$/u);
 expect(f.custody.read()).toEqual(held);await expect(f.custody.prepare(input(),()=>true)).rejects.toThrow();expect(f.uuid).toHaveBeenCalledTimes(1);f.custody.complete(held);expect(f.custody.read()).toBeNull();
});
it('identity/expiry changes and superseded hash wait cannot save or expose previous custody',async()=>{
 const f=setup();await expect(f.custody.prepare(input(),()=>false)).rejects.toThrow();expect(f.bytes.size).toBe(0);
 const held=await f.custody.prepare(input(),()=>true);f.change({identity:'other',expiresAt:held.expiresAt});expect(f.custody.read()).toBeNull();expect(f.bytes.size).toBe(0);
 f.change(null);await expect(f.custody.prepare(input(),()=>true)).rejects.toThrow();
});
it('failed storage/readback and unsupported WebLock block rather than dispatch or reconstruct',async()=>{
 const f=setup();vi.spyOn(f.storage,'setItem').mockImplementation(()=>{throw Error('Storage refused');});await expect(f.custody.prepare(input(),()=>true)).rejects.toThrow();expect(f.custody.read()).toBeNull();await expect(f.custody.exclusive(async()=>true)).rejects.toThrow();
});
