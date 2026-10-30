import {access,readFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {startPostgresCluster} from '../../db/testing/embeddedPostgres.ts';
import {startTestDatabaseEnvironment} from '../../db/testing/globalSetup.ts';
/** Root grants one owned disposable allocator; never adopts an existing server. */
export default async function setup(){
 if(process.env['FSS_TEST_POSTGRES_URL']||process.env['FSS_TEST_CLUSTER_URL'])throw Error('Prepared acceptance refuses an inherited PostgreSQL cluster');
 return startTestDatabaseEnvironment(async()=>{
  const cluster=await startPostgresCluster(),port=Number(new URL(cluster.adminUrl).port);
  const pid=cluster.storagePath?Number((await readFile(cluster.storagePath+'/postmaster.pid','utf8')).split('\n')[0]):undefined;
  console.log('PREPARED_PROSPECTS_PG_OWNED',JSON.stringify({source:cluster.source,storagePath:cluster.storagePath,port,pid}));
  return {...cluster,stop:async()=>{
   await cluster.stop();let storageAbsent:boolean|null=null,processAbsent:boolean|null=null;
   if(cluster.storagePath){try{await access(cluster.storagePath);storageAbsent=false;}catch{storageAbsent=true;}}
   if(pid){try{process.kill(pid,0);processAbsent=false;}catch{processAbsent=true;}}
   const portAbsent=await new Promise<boolean>(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',()=>resolve(true));socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});});
   console.log('PREPARED_PROSPECTS_PG_CLEANUP',JSON.stringify({storagePath:cluster.storagePath,port,pid,storageAbsent,processAbsent,portAbsent}));
   if(storageAbsent===false||processAbsent===false||!portAbsent)throw Error('Owned prepared-prospect PostgreSQL cleanup incomplete');
  }};
 });
}
