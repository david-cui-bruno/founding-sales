import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {founderHostDatabase} from './founderHostResources.ts';
import {requireGlassRuntimeGrant} from './glassWorkspaceApp.ts';
export default async function setup(){
 requireGlassRuntimeGrant();
 const homebrew=execFileSync('ps',['-p','1106','-o','command='],{encoding:'utf8'}).trim();
 assert(homebrew.includes('/opt/homebrew/opt/postgresql@17/bin/postgres'));
 console.log('CALLING_EXECUTION_RESOURCE_RESERVATION',JSON.stringify({owner:'swan',grant:'fox-20261026-105435',resources:['one disposable PG cluster/template/fixture','loopback only'],homebrew1106:homebrew,workers:1}));
 const owned=await founderHostDatabase();
 return async()=>{await owned.stop();assert.equal(execFileSync('ps',['-p','1106','-o','command='],{encoding:'utf8'}).trim(),homebrew);console.log('CALLING_EXECUTION_PG_RELEASED_HOME BREW1106_UNCHANGED');};
}
