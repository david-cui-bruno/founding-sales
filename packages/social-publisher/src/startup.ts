import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {SocialBufferPublisher} from './publisherRuntime.ts';
import {postgresPublisherCredentials,type PublisherCredentialStore,type PublisherExecutionSide} from './publisherCredentials.ts';
import {publisherProductionConfiguration} from './publisherConfig.ts';
export interface PublisherDatabaseLease {readonly session:SessionQueryable;close():Promise<void>}
export interface PublisherRuntimeHandle {readonly publisher:SocialBufferPublisher;stop():Promise<void>}
/** A short-lived owned DB lease per operation, never a captured request connection. */
export async function startSocialPublisher(options:{environment:NodeJS.ProcessEnv;executionSide:PublisherExecutionSide;openSession:()=>Promise<PublisherDatabaseLease>;onHeartbeatError:()=>void}):Promise<PublisherRuntimeHandle|undefined>{
 const configured=publisherProductionConfiguration(options.environment);if(!configured)return undefined;
 const key=configured.credentialKey;
 const useStore=async<T>(work:(store:PublisherCredentialStore)=>Promise<T>):Promise<T>=>{const lease=await options.openSession();try{return await work(postgresPublisherCredentials(lease.session,key));}finally{await lease.close();}};
 const credentials:PublisherCredentialStore={read:binding=>useStore(store=>store.read(binding)),save:(owner,accountId,identity,apiKey,authority)=>useStore(store=>store.save(owner,accountId,identity,apiKey,authority)),disconnect:(owner,accountId,authority)=>useStore(store=>store.disconnect(owner,accountId,authority)),heartbeat:side=>useStore(store=>store.heartbeat(side))};
 const publisher=new SocialBufferPublisher({credentials,mediaOrigin:configured.mediaOrigin,executionSide:options.executionSide});
 try{await publisher.start();}catch{try{await publisher.close();}finally{key.fill(0);}throw new Error('social_publisher_startup_failed');}
 let heartbeat:Promise<void>|undefined;
 const timer=setInterval(()=>{if(heartbeat)return;heartbeat=publisher.heartbeat().catch(()=>options.onHeartbeatError()).finally(()=>{heartbeat=undefined;});},30000);timer.unref();
 return {publisher,async stop(){clearInterval(timer);try{await heartbeat;}finally{try{await publisher.close();}finally{key.fill(0);}}}};
}
