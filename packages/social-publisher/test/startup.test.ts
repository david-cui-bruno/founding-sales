import {afterEach,expect,it,vi} from 'vitest';
import type {PublisherCredentialStore} from '../src/publisherCredentials.ts';
import {startSocialPublisher} from '../src/startup.ts';
const fixture=vi.hoisted(()=>({heartbeat:vi.fn(async()=>{}),closed:vi.fn(async()=>{})}));
vi.mock('../src/publisherCredentials.ts',()=>({postgresPublisherCredentials:():PublisherCredentialStore=>({read:async()=>null,save:async()=>{throw new Error('unused');},disconnect:async()=>{},heartbeat:fixture.heartbeat})}));
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
it('disables absent configuration without opening a DB lease',async()=>{const openSession=vi.fn();expect(await startSocialPublisher({environment:{},executionSide:'api',openSession,onHeartbeatError:vi.fn()})).toBeUndefined();expect(openSession).not.toHaveBeenCalled();});
it('uses fresh short-lived leases and reports heartbeat failure without stopping the runtime',async()=>{
 vi.useFakeTimers();const query=async()=>({rows:[],rowCount:0});const openSession=vi.fn(async()=>({session:{query},close:fixture.closed})),onHeartbeatError=vi.fn();
 const handle=await startSocialPublisher({environment:{FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY:Buffer.alloc(32,3).toString('base64'),FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN:'https://app.example'},executionSide:'worker',openSession,onHeartbeatError});
 expect(handle).toBeDefined();expect(openSession).toHaveBeenCalledTimes(1);expect(fixture.closed).toHaveBeenCalledTimes(1);
 fixture.heartbeat.mockRejectedValueOnce(new Error('private-database-error'));await vi.advanceTimersByTimeAsync(30000);expect(onHeartbeatError).toHaveBeenCalledTimes(1);expect(fixture.closed).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(30000);expect(fixture.heartbeat).toHaveBeenCalledTimes(3);expect(onHeartbeatError).toHaveBeenCalledTimes(1);
 await handle?.stop();await vi.advanceTimersByTimeAsync(60000);expect(fixture.heartbeat).toHaveBeenCalledTimes(3);
});
it('closes the startup lease and returns only a bounded failure when local capability startup fails',async()=>{
 fixture.heartbeat.mockRejectedValueOnce(new Error('private database secret'));const openSession=vi.fn(async()=>({session:{query:async()=>({rows:[],rowCount:0})},close:fixture.closed}));
 await expect(startSocialPublisher({environment:{FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY:Buffer.alloc(32).toString('base64'),FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN:'https://app.example'},executionSide:'api',openSession,onHeartbeatError:vi.fn()})).rejects.toThrow('social_publisher_startup_failed');expect(fixture.closed).toHaveBeenCalledTimes(1);
});
