import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {SocialBrowserPublisher} from './publisherRuntime.ts';
import {postgresPublisherSessions,type PublisherSessionStore,type PublisherExecutionSide} from './publisherSessions.ts';
import {publisherProductionConfiguration} from './publisherConfig.ts';

export interface PublisherDatabaseLease {
 readonly session:SessionQueryable;
 close():Promise<void>;
}
export interface PublisherRuntimeHandle {
 readonly publisher:SocialBrowserPublisher;
 stop():Promise<void>;
}
/** One owned browser per process, never a pooled BEGIN/COMMIT or captured request connection. */
export async function startSocialPublisher(options:{
 environment:NodeJS.ProcessEnv;
 executionSide:PublisherExecutionSide;
 openSession:()=>Promise<PublisherDatabaseLease>;
 onHeartbeatError:()=>void;
}):Promise<PublisherRuntimeHandle|undefined>{
 const configured=publisherProductionConfiguration(options.environment);
 if(!configured)return undefined;
 const key=configured.sessionKey;
 const useStore=async<T>(work:(store:PublisherSessionStore)=>Promise<T>):Promise<T>=>{
  const lease=await options.openSession();
  try{return await work(postgresPublisherSessions(lease.session,key));}
  finally{await lease.close();}
 };
 const sessions:PublisherSessionStore={
  read:binding=>useStore(store=>store.read(binding)),
  save:(owner,accountId,identity,state,authority)=>useStore(store=>store.save(owner,accountId,identity,state,authority)),
  disconnect:(owner,accountId,authority)=>useStore(store=>store.disconnect(owner,accountId,authority)),
  heartbeat:(executionSide,version)=>useStore(store=>store.heartbeat(executionSide,version)),
 };
 const publisher=new SocialBrowserPublisher({sessions,browser:configured.browser,executionSide:options.executionSide,maxConnections:1,connectionLifetimeMs:600_000});
 try{await publisher.start();}
 catch{try{await publisher.close();}catch{/* Startup still fails; never expose cleanup details. */}finally{key.fill(0);configured.browser.token.fill(0);}throw new Error('social_publisher_startup_failed');}
 let heartbeat:Promise<void>|undefined;
 const timer=setInterval(()=>{
  if(heartbeat)return;
  heartbeat=publisher.heartbeat().catch(()=>options.onHeartbeatError()).finally(()=>{heartbeat=undefined;});
 },30_000);
 timer.unref();
 return {publisher,async stop(){clearInterval(timer);try{await heartbeat;}finally{try{await publisher.close();}finally{key.fill(0);configured.browser.token.fill(0);}}}};
}
