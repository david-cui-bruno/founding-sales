import {randomUUID,createHash} from 'node:crypto';
import {chromium,type Browser,type BrowserContext,type BrowserContextOptions,type Page} from 'playwright';
import {SOCIAL_BROWSER_ADAPTER,socialPublisherConnectionInputSchema,type SocialPublisherBinding,type SocialPublisherAttempt,type SocialPublisherObservation,type SocialPublisherPort,type SocialPublisherPrepared,type SocialPublisherConnectionInput,type SocialPublisherConnectionResult} from '@fss/contracts';
import type {PublisherOwner,PublisherSessionStore,PublisherExecutionSide} from './publisherSessions.ts';
import {LinkedinBrowserRoute,PublisherRefusal} from './publisherLinkedin.ts';
import {attestPublisherSandbox} from './publisherSandbox.ts';
import {assertPublisherDebugDisabled,publisherRemoteEndpoint,type PublisherBrowserConnection} from './publisherConfig.ts';
import {createPrivatePublisherLaunch,type PrivatePublisherLaunch} from './publisherNative.ts';

export interface SocialBrowserRuntimeOptions {sessions:PublisherSessionStore;executionSide:PublisherExecutionSide;browser:PublisherBrowserConnection;maxConnections?:number;connectionLifetimeMs?:number}
export interface PublisherConnectionOwner extends PublisherOwner {sessionId:string;deviceId:string}
interface Login {owner:PublisherConnectionOwner;accountId:string;context:BrowserContext;page:Page;expiresAt:number;lastInputAt:number;busy:boolean;phase:'login'|'verify'}
/** No browser/CDP endpoint is exposed. Each owner login and operation has an isolated context. */
export class SocialBrowserPublisher implements SocialPublisherPort {
 private browser:Browser|null=null;
 private starting:Promise<Browser>|null=null;
 private readonly logins=new Map<string,Login>();
 private readonly route:LinkedinBrowserRoute;
 private readonly fixtureOrigin:string|null;
 private readonly activeAttempts=new Set<string>();
 private connectingStarts=0;
 private readonly interactiveContexts=new WeakSet<BrowserContext>();
 private localLaunch:PrivatePublisherLaunch|null=null;
 private closed=false;
 private closing:Promise<void>|null=null;
 constructor(private readonly options:SocialBrowserRuntimeOptions,fixture?:{origin:string}){
  if(options.browser.kind==='local'&&!fixture)throw new Error('local_publisher_fixture_required');
  this.fixtureOrigin=fixture?.origin??null;
  if(this.fixtureOrigin){const url=new URL(this.fixtureOrigin);if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.origin!==this.fixtureOrigin)throw new Error('publisher_fixture_origin_invalid');}
  this.route=new LinkedinBrowserRoute(this.fixtureOrigin??undefined);
 }
 async start():Promise<void>{const browser=await this.launch();await this.options.sessions.heartbeat(this.options.executionSide,browser.version());}
 async heartbeat():Promise<void>{const browser=await this.launch();await this.options.sessions.heartbeat(this.options.executionSide,browser.version());}
 close():Promise<void>{
  if(this.closing)return this.closing;
  this.closed=true;
  this.closing=(async()=>{
   let failed=false;
   try{await this.starting;}catch{/* A failed connection has no provider result to recover. */}
   for(const login of this.logins.values())try{await login.context.close();}catch{failed=true;}
   this.logins.clear();
   try{await this.browser?.close();}catch{failed=true;}finally{this.browser=null;}
   try{await this.localLaunch?.close();}catch{failed=true;}finally{this.localLaunch=null;}
   if(failed)throw new PublisherRefusal('runtime_shutdown_failed');
  })();
  return this.closing;
 }
 private async launch():Promise<Browser>{
  if(this.closed)throw new PublisherRefusal('runtime_closed');
  if(this.browser?.isConnected())return this.browser;
  if(this.starting)return this.starting;
  assertPublisherDebugDisabled(process.env);
  this.starting=(async()=>{
   const connection=this.options.browser;let browser:Browser;
   if(connection.kind==='remote'){
    if(connection.token.length!==32||process.env['NODE_TLS_REJECT_UNAUTHORIZED']==='0')throw new PublisherRefusal('remote_transport_invalid');
    browser=await chromium.connect(publisherRemoteEndpoint(connection.endpoint),{headers:{Authorization:`Bearer ${connection.token.toString('base64')}`},timeout:20000});
   }else{
    this.localLaunch??=await createPrivatePublisherLaunch(connection.executablePath);
    browser=await chromium.launch(this.localLaunch.options);
   }
   try{await attestPublisherSandbox(browser,connection.kind==='remote'?'linux-host':'local');}
   catch(error){await browser.close();throw error;}
   browser.on('disconnected',()=>{if(this.browser===browser){this.browser=null;this.logins.clear();}});
   return browser;
  })();
  try{this.browser=await this.starting;return this.browser;}
  catch{throw new PublisherRefusal('runtime_unavailable');}
  finally{this.starting=null;}
 }
 private async context(state?:string):Promise<BrowserContext>{
  const browser=await this.launch();
  let storageState:BrowserContextOptions['storageState'];
  try{storageState=state?JSON.parse(state):undefined;}catch{throw new PublisherRefusal('session_unavailable');}
  const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'UTC',locale:'en-US',acceptDownloads:false,serviceWorkers:'block',...(storageState?{storageState}:{})});
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   const allowed=this.fixtureOrigin?url.origin===this.fixtureOrigin:url.protocol==='https:'&&['linkedin.com','www.linkedin.com','static.licdn.com','media.licdn.com','dms.licdn.com','www.google.com','www.gstatic.com','www.recaptcha.net'].includes(url.hostname);
   if(this.interactiveContexts.has(context)){
    const request=route.request();
    const loginPath=/^\/(login|uas\/|checkpoint|challenge)/u.test(url.pathname);
    const topNavigation=request.isNavigationRequest()&&request.frame().parentFrame()===null;
    const mutable=!['GET','HEAD','OPTIONS'].includes(request.method());
    if(topNavigation&&!loginPath||url.pathname.startsWith('/voyager/')||mutable&&!loginPath&&!url.pathname.startsWith('/recaptcha/')){await route.abort('blockedbyclient');return;}
   }
   if(allowed)await route.continue();else await route.abort('blockedbyclient');
  });
  context.on('page',page=>{page.on('popup',popup=>{void popup.close();});});
  context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(20000);
  return context;
 }
 private async login(owner:PublisherConnectionOwner,id:string):Promise<Login>{
  const login=this.logins.get(id);
  if(!login||login.owner.workspaceId!==owner.workspaceId||login.owner.ownerUserId!==owner.ownerUserId||login.owner.sessionId!==owner.sessionId||login.owner.deviceId!==owner.deviceId)throw new PublisherRefusal('connection_unavailable');
  if(login.expiresAt<=Date.now()){this.logins.delete(id);await login.context.close();throw new PublisherRefusal('connection_expired');}
  return login;
 }
 private async loginFlow(page:Page):Promise<boolean>{
  const url=new URL(page.url());
  const expected=this.fixtureOrigin??'https://www.linkedin.com';
  return url.origin===expected&&/^\/(login|uas\/login|checkpoint|challenge|uas\/consumer-email-challenge)/u.test(url.pathname);
 }
 async connection(owner:PublisherConnectionOwner,raw:SocialPublisherConnectionInput,authority:()=>Promise<void>):Promise<SocialPublisherConnectionResult>{
  const input=socialPublisherConnectionInputSchema.parse(raw);await authority();
  if(input.operation==='start'){
   for(const [id,login]of this.logins){if(login.expiresAt<=Date.now()){this.logins.delete(id);await login.context.close();}}
   if(this.logins.size+this.connectingStarts>=(this.options.maxConnections??1))throw new PublisherRefusal('connection_capacity');
   this.connectingStarts++;
   try{
    const context=await this.context();const connectionId=randomUUID();
    this.interactiveContexts.add(context);
    try{
     const page=await context.newPage();
     const expiresAt=Date.now()+Math.min(this.options.connectionLifetimeMs??600000,600000);
     const login:Login={owner:{...owner},accountId:input.accountId,context,page,expiresAt,lastInputAt:0,busy:false,phase:'login'};
     this.logins.set(connectionId,login);
     const timer=setTimeout(()=>{if(this.logins.get(connectionId)===login){this.logins.delete(connectionId);void context.close();}},expiresAt-Date.now());timer.unref();
     await page.goto(`${this.fixtureOrigin??'https://www.linkedin.com'}/login`,{waitUntil:'domcontentloaded'});await authority();
     return {state:'connecting',connectionId,expiresAt:new Date(expiresAt).toISOString()};
    }catch{this.logins.delete(connectionId);await context.close();throw new PublisherRefusal('connection_unavailable');}
   }finally{this.connectingStarts--;}
  }
  if(input.operation==='disconnect'){
   await this.options.sessions.disconnect(owner,input.accountId,authority);await authority();
   for(const [id,login]of this.logins){if(login.owner.workspaceId===owner.workspaceId&&login.owner.ownerUserId===owner.ownerUserId&&login.accountId===input.accountId){this.logins.delete(id);await login.context.close();}}
   return {state:'closed'};
  }
  const login=await this.login(owner,input.connectionId);
  if(login.busy)throw new PublisherRefusal('connection_busy');login.busy=true;
  try{
   if(input.operation==='abort'){this.logins.delete(input.connectionId);await login.context.close();await authority();return {state:'closed'};}
   if(input.operation==='complete'){
    login.phase='verify';this.interactiveContexts.delete(login.context);
    try{
     const identity=await this.route.self(login.page);await authority();
     const allowedDomains=this.fixtureOrigin?[new URL(this.fixtureOrigin).hostname]:['linkedin.com','www.linkedin.com'];
     const snapshot=await login.context.storageState();
     let state=JSON.stringify({cookies:snapshot.cookies.filter(cookie=>allowedDomains.includes(cookie.domain.replace(/^\./u,''))),origins:[]});
     // Do not retain LinkedIn localStorage/feed caches or third-party captcha state.
     await login.context.close();await authority();
     const candidate=await this.context(state);
     try{
      const page=await candidate.newPage(),self=await this.route.self(page);await authority();
      if(identity.externalId!==self.externalId)throw new PublisherRefusal('account_mismatch');
      await this.route.capabilities(page);await authority();
      const checked=await this.route.self(page);if(checked.externalId!==identity.externalId)throw new PublisherRefusal('account_mismatch');
      const usable=await candidate.storageState();
      state=JSON.stringify({cookies:usable.cookies.filter(cookie=>allowedDomains.includes(cookie.domain.replace(/^\./u,''))),origins:[]});
      const binding=await this.options.sessions.save(owner,login.accountId,checked,state,authority);await authority();
      return {state:'connected',accountId:binding.accountId,revision:binding.accountRevision,externalId:binding.externalId,displayName:checked.displayName};
     }finally{await candidate.close();}
    }finally{this.logins.delete(input.connectionId);await login.context.close();}
   }
   if(login.phase!=='login'||!await this.loginFlow(login.page))throw new PublisherRefusal('connection_ready_to_verify');
   if(Date.now()-login.lastInputAt<150)throw new PublisherRefusal('connection_rate_limited');login.lastInputAt=Date.now();
   if(input.operation==='input'){
    await authority();
    const event=input.event;
    if(event.kind==='click')await login.page.mouse.click(event.x,event.y);
    else if(event.kind==='text')await login.page.keyboard.insertText(event.text);
    else if(event.kind==='key')await login.page.keyboard.press(event.key);
    else await login.page.mouse.wheel(0,event.deltaY);
   }
   await authority();
   // Never project authenticated feed/inbox or arbitrary browser pages.
   if(!await this.loginFlow(login.page))throw new PublisherRefusal('connection_ready_to_verify');
   let image=(await login.page.screenshot({type:'jpeg',quality:65,animations:'disabled'})).toString('base64');
   if(image.length>600000){await authority();image=(await login.page.screenshot({type:'jpeg',quality:40,animations:'disabled'})).toString('base64');}
   if(image.length>600000)throw new PublisherRefusal('connection_frame_too_large');
   await authority();if(!await this.loginFlow(login.page))throw new PublisherRefusal('connection_ready_to_verify');
   return {state:'frame',connectionId:input.connectionId,image,width:1280,height:900};
  }finally{login.busy=false;}
 }
 private async operation<T>(binding:SocialPublisherBinding,authority:()=>Promise<void>,action:(page:Page)=>Promise<T>):Promise<T>{
  await authority();const state=await this.options.sessions.read(binding);
  if(!state)throw new PublisherRefusal('session_unavailable');
  const context=await this.context(state);
  try{
   const page=await context.newPage();const self=await this.route.self(page);await authority();
   if(self.externalId!==binding.externalId)throw new PublisherRefusal('account_mismatch');
   if(!await this.options.sessions.read(binding))throw new PublisherRefusal('session_unavailable');
   return await action(page);
  }finally{await context.close();}
 }
 async verify(binding:SocialPublisherBinding):Promise<{usable:boolean;externalId:string|null;adapter:typeof SOCIAL_BROWSER_ADAPTER}>{
  try{return await this.operation(binding,async()=>{},async page=>{await this.route.capabilities(page);if(!await this.options.sessions.read(binding))throw new PublisherRefusal('session_unavailable');return {usable:true,externalId:binding.externalId,adapter:SOCIAL_BROWSER_ADAPTER};});}
  catch{return {usable:false,externalId:null,adapter:SOCIAL_BROWSER_ADAPTER};}
 }
 private validate(attempt:SocialPublisherAttempt,write=false):void {
  if(!/^[0-9a-f-]{36}$/iu.test(attempt.attemptId)||!/^[a-f0-9]{64}$/u.test(attempt.fingerprint))throw new PublisherRefusal('attempt_invalid');
  if(attempt.text===null?write||!attempt.textSHA256||!/^[a-f0-9]{64}$/u.test(attempt.textSHA256):!attempt.text.trim()||attempt.text.length>3000)throw new PublisherRefusal('attempt_invalid');
  if(attempt.text!==null&&attempt.textSHA256&&createHash('sha256').update(attempt.text.replace(/\r\n/gu,'\n').trim()).digest('hex')!==attempt.textSHA256)throw new PublisherRefusal('attempt_invalid');
  const at=Date.parse(attempt.publishAt);
  if(!Number.isFinite(at))throw new PublisherRefusal('attempt_invalid');
  const image=attempt.image;
  if(image&&(!/^[a-f0-9]{64}$/u.test(image.sha256)||!['image/jpeg','image/png'].includes(image.mime)||write&&(!image.bytes||!image.altText.trim()||image.altText.length>1000)||image.bytes&&(image.bytes.length>5*1024*1024||createHash('sha256').update(image.bytes).digest('hex')!==image.sha256)))throw new PublisherRefusal('image_invalid');
 }
 async prepare(attempt:SocialPublisherAttempt,authority:()=>Promise<void>):Promise<SocialPublisherPrepared>{
  this.validate(attempt,true);const at=Date.parse(attempt.publishAt);
  if(at<=Date.now()+300000||at>Date.now()+30*86400000)throw new PublisherRefusal('schedule_window_invalid');
  await this.operation(attempt.binding,authority,async page=>{await this.route.capabilities(page);await authority();});
  return {attemptId:attempt.attemptId,fingerprint:attempt.fingerprint,expiresAt:new Date(Math.min(at-300000,Date.now()+60000)).toISOString()};
 }
 private observation(attempt:SocialPublisherAttempt,reason:SocialPublisherObservation['reason']='readback_incomplete'):SocialPublisherObservation {
  return {state:'unknown',receiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:null,fingerprint:attempt.fingerprint,imageCount:attempt.image?1:0,loadedPreview:false,reason};
 }
 async submit(attempt:SocialPublisherAttempt,authority:()=>Promise<void>,durableMarker:()=>Promise<boolean>):Promise<SocialPublisherObservation>{
  this.validate(attempt,true);
  if(this.activeAttempts.has(attempt.attemptId))return this.observation(attempt);
  this.activeAttempts.add(attempt.attemptId);
  try{
   return await this.operation(attempt.binding,authority,async page=>{
    if(Date.parse(attempt.publishAt)<=Date.now()+300000||Date.parse(attempt.publishAt)>Date.now()+30*86400000)throw new PublisherRefusal('schedule_window_invalid');
    const current=async()=>{await authority();if(!await this.options.sessions.read(attempt.binding))throw new PublisherRefusal('session_unavailable');};
    await current();
    // Commit before image upload as well as the final Schedule click.
    try{if(!await durableMarker())return this.observation(attempt);}catch{return this.observation(attempt);}
    try{
     await current();await this.route.compose(page,attempt,current);
     await current();await this.route.finalSubmit(page);
    }catch{return this.observation(attempt);}
    // Readback uses a fresh context; a click/acknowledgement cannot establish a schedule.
    return this.inspect(attempt,null,authority);
   });
  }finally{this.activeAttempts.delete(attempt.attemptId);}
 }
 async inspect(attempt:SocialPublisherAttempt,receiptId:string|null,authority:()=>Promise<void>):Promise<SocialPublisherObservation>{
  this.validate(attempt);if(receiptId!==null&&!/^urn:li:(activity|share):\d+$/u.test(receiptId))return this.observation(attempt);
  try{return await this.operation(attempt.binding,authority,async page=>{
   const match=await this.route.inspect(page,attempt,receiptId);await authority();
   if(!match)return this.observation(attempt);
   return {...this.observation(attempt,'matched'),...match,accountExternalId:attempt.binding.externalId};
  });}catch(error){return this.observation(attempt,error instanceof PublisherRefusal&&error.reason==='account_mismatch'?'account_mismatch':error instanceof PublisherRefusal&&error.reason==='session_unavailable'?'session_unavailable':'remote_unavailable');}
 }
 async cancel(attempt:SocialPublisherAttempt,receiptId:string,authority:()=>Promise<void>):Promise<SocialPublisherObservation>{
  this.validate(attempt);if(!/^urn:li:(activity|share):\d+$/u.test(receiptId))return this.observation(attempt);
  try{
   const cancelled=await this.operation(attempt.binding,authority,async page=>this.route.cancel(page,attempt,receiptId,async()=>{await authority();if(!await this.options.sessions.read(attempt.binding))throw new PublisherRefusal('session_unavailable');}));
   const observed=await this.inspect(attempt,receiptId,authority);
   if(observed.state==='published')return observed;
   // route.cancel returned true only after exact pre-cancel content/image readback,
   // a witnessed native delete acknowledgement and fresh independent absence.
   if(cancelled&&observed.state==='unknown'&&observed.reason==='readback_incomplete')return {...observed,state:'cancelled',receiptId,accountExternalId:attempt.binding.externalId,loadedPreview:true,reason:'matched'};
   return {...observed,reason:observed.state==='scheduled'?'cancel_race':observed.reason};
  }catch{return this.observation(attempt,'cancel_race');}
 }
}
