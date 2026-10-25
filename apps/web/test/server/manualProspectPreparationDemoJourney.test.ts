import assert from 'node:assert/strict';
import {it,expect} from 'vitest';
import {access,chmod,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {connect} from 'node:net';
import {chromium,type Browser,type BrowserContext} from 'playwright';
import {startSyntheticBrowser,containSyntheticBrowser,signInSyntheticBrowser,assertSyntheticNoSend} from '../support/syntheticBrowserApp.ts';
import {exerciseManualProspectPreparationDemo} from '../support/manualProspectPreparationDemoJourney.ts';

async function listenerAbsent(address:string):Promise<void>{
 const url=new URL(address);
 const error=await new Promise<NodeJS.ErrnoException>((resolve,reject)=>{const socket=connect({host:url.hostname,port:Number(url.port)});socket.once('connect',()=>{socket.destroy();reject(Error('Owned listener remains'));});socket.once('error',resolve);});
 expect(error.code).toBe('ECONNREFUSED');
}
it.skipIf(process.env['FSS_MANUAL_PREPARATION_PROOF']!=='1')('issue785 actual signed current-product manual draft to explicit fictional callback and deliberate reopen',async()=>{
 expect(process.env['FSS_MANUAL_PREPARATION_EXCLUSIVE_LANE']).toBe('785');
 const proof=process.env['FSS_SYNTHETIC_PROOF_DIR'];if(proof){await mkdir(proof,{recursive:true,mode:0o700});await chmod(proof,0o700);}
 const executable=process.env['FSS_LOCAL_BROWSER_EXECUTABLE'];assert(executable);expect(executable).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 const existing=execFileSync('/bin/ps',['-axo','pid,command'],{encoding:'utf8'});
 expect(existing.split('\n').filter(line=>/(?:^|\s)(?:\S*\/)?postgres(?:\s|$)/u.test(line)&&!/postgres: /u.test(line)).every(line=>line.includes('/opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17'))).toBe(true);
 const runtime=await startSyntheticBrowser({manualPreparation:true}),app=runtime.app;
 let browser:Browser|undefined,context:BrowserContext|undefined,profile:string|undefined,chromePid:number|undefined;
 const origin=app.origin,issuer=app.fixture.google.issuer;
 try{
  expect(runtime.manualPreparation).toBeTruthy();
  const before:Record<string,unknown[]>={};
  for(const table of ['sourcing_candidates','firms','contacts','phone_routes','email_addresses','sequence_enrollments','outbound_messages','sourcing_admissions','suppression_events','today_items','call_logs','callbacks','phone_handoff_attempts'])before[table]=(await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  browser=await chromium.launch({executablePath:executable,headless:true});context=await browser.newContext({ignoreHTTPSErrors:true,serviceWorkers:'block',acceptDownloads:false,viewport:{width:1440,height:1000}});
  const owned=execFileSync('/bin/ps',['-axo','pid,command'],{encoding:'utf8'}).split('\n').filter(line=>line.includes(`${executable} `)&&line.includes('--remote-debugging-pipe')&&!line.includes('--type='));expect(owned).toHaveLength(1);
  profile=/--user-data-dir=([^ ]+)/u.exec(owned[0]!)?.[1];chromePid=Number(owned[0]!.trim().split(/\s+/u)[0]);expect(profile).toBeTruthy();
  console.log('MANUAL_PREPARATION_785_CHROME_OWNED',JSON.stringify({chromePid,profile,version:browser.version()}));
  await containSyntheticBrowser(context,app);const page=await context.newPage();await signInSyntheticBrowser(page,app);
  const result=await exerciseManualProspectPreparationDemo(page,app,runtime.manualPreparation!,proof);
  expect(result.runtimeRoleChecks).toBeGreaterThan(0);expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
  for(const [table,rows] of Object.entries(before))expect((await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows,table).toEqual(rows);
  await assertSyntheticNoSend(app);console.log('MANUAL_PREPARATION_785_CHANGED_JOURNEY_PASS',JSON.stringify(result));
 }finally{
  try{try{await context?.close();}finally{await browser?.close();}}finally{await runtime.stop();}
  if(profile)await access(profile).then(()=>{throw Error('Owned Chrome profile remains');},error=>{expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');});
  if(chromePid){const pid=chromePid;expect(()=>process.kill(pid,0)).toThrow();}await listenerAbsent(origin);await listenerAbsent(issuer);expect(()=>process.kill(1106,0)).not.toThrow();
  console.log('MANUAL_PREPARATION_785_OWNED_CLEANUP_VERIFIED');
 }
},180000);
