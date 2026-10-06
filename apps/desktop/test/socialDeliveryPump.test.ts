import {afterEach,it,expect,vi} from 'vitest';
import {createSocialDeliveryPump} from '../src/main/social/deliveryPump.ts';
import type {SocialDeliveryQueue} from '@fss/contracts';
afterEach(()=>vi.useRealTimers());
const item={deliveryId:'d',postId:'p',revision:1,action:'inspect',submissionId:'s',receiptId:null,fingerprint:'hash',snapshot:{account:{id:'a'}}} as SocialDeliveryQueue['items'][number];
it('polls once on start then every minute, and stops cleanly',async()=>{
 vi.useFakeTimers();const read=vi.fn(async()=>({items:[]})),run=vi.fn();const pump=createSocialDeliveryPump({read,run});pump.start();await vi.advanceTimersByTimeAsync(0);expect(read).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(60_000);expect(read).toHaveBeenCalledTimes(2);pump.stop();await vi.advanceTimersByTimeAsync(120_000);expect(read).toHaveBeenCalledTimes(2);
});
it('coalesces overlapping wakeups and invalidates active work on stop',async()=>{
 vi.useFakeTimers();let finish:()=>void=()=>{};let current:()=>boolean=()=>false;
 const read=vi.fn(async()=>({items:[item]}));const run=vi.fn(async(_item:typeof item,isCurrent:()=>boolean)=>{current=isCurrent;await new Promise<void>(r=>{finish=r;});});
 const pump=createSocialDeliveryPump({read,run});pump.start();await vi.advanceTimersByTimeAsync(0);pump.wake();pump.wake();expect(read).toHaveBeenCalledTimes(1);expect(current()).toBe(true);pump.stop();expect(current()).toBe(false);finish();await vi.advanceTimersByTimeAsync(0);expect(read).toHaveBeenCalledTimes(1);
});
it('continues after one failed item and retries offline reads only on the next wake',async()=>{
 vi.useFakeTimers();const read=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({items:[item,{...item,deliveryId:'second'}]});const run=vi.fn().mockRejectedValueOnce(new Error('browser unavailable')).mockResolvedValue(undefined);
 const pump=createSocialDeliveryPump({read,run});pump.start();await vi.advanceTimersByTimeAsync(0);expect(run).not.toHaveBeenCalled();pump.wake();await vi.advanceTimersByTimeAsync(0);expect(run).toHaveBeenCalledTimes(2);pump.stop();
});
