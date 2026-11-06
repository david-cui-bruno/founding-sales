import {founderHostDatabase} from './founderHostResources.ts';
import {requireCallingM2Admission} from './glassWorkspaceApp.ts';
import {assertForeignPostgresPreserved,CALLING_M2_GRANT,CALLING_M2_GRANT_ENV} from './soleDisposableLane.ts';
export default async function setup(){
 const foreignPostgres=requireCallingM2Admission();
 console.log('CALLING_EXECUTION_RESOURCE_RESERVATION',JSON.stringify({grant:{env:CALLING_M2_GRANT_ENV,value:CALLING_M2_GRANT},resources:['one disposable PG cluster/template/fixture','loopback only'],foreignPostgres,workers:1}));
 const owned=await founderHostDatabase();
 return async()=>{await owned.stop();assertForeignPostgresPreserved(foreignPostgres);console.log('CALLING_EXECUTION_PG_RELEASED_FOREIGN_POSTGRES_UNCHANGED');};
}
