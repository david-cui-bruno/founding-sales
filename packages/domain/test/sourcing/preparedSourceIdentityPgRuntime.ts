import {access,readFile} from 'node:fs/promises';
import {startPostgresCluster} from '../../db/testing/embeddedPostgres.ts';
import {startTestDatabaseEnvironment} from '../../db/testing/globalSetup.ts';
/** Same standard allocator/teardown, with exact owned local custody and absence evidence. */
export default async function setup(){
 return startTestDatabaseEnvironment(async()=>{
  const cluster=await startPostgresCluster();
  const port=Number(new URL(cluster.adminUrl).port);
  let pid:number|undefined;
  if(cluster.storagePath)pid=Number((await readFile(cluster.storagePath+'/postmaster.pid','utf8')).split('\n')[0]);
  console.log('PREPARED_IDENTITY_PG_OWNED',JSON.stringify({source:cluster.source,storagePath:cluster.storagePath,port,pid}));
  return {...cluster,stop:async()=>{
   await cluster.stop();let storageAbsent:boolean|null=null,processAbsent:boolean|null=null;
   if(cluster.storagePath){try{await access(cluster.storagePath);storageAbsent=false;}catch{storageAbsent=true;}}
   if(pid){try{process.kill(pid,0);processAbsent=false;}catch{processAbsent=true;}}
   console.log('PREPARED_IDENTITY_PG_CLEANUP',JSON.stringify({storagePath:cluster.storagePath,port,pid,storageAbsent,processAbsent}));
   if(storageAbsent===false||processAbsent===false)throw Error('Owned prepared-identity PostgreSQL cleanup incomplete');
  }};
 });
}
