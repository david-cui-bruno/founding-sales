import {createHash} from 'node:crypto';
export type SocialPlatform='linkedin'|'facebook'|'x';
export interface SocialScope {workspaceId:string;userId:string;accountId:string;platform:SocialPlatform}
export interface SocialWindowOptions {show:false;width:number;height:number;webPreferences:{sandbox:true;contextIsolation:true;nodeIntegration:false;nodeIntegrationInWorker:false;nodeIntegrationInSubFrames:false;webSecurity:true;allowRunningInsecureContent:false;webviewTag:false;devTools:false;partition:string}}
interface Preventable {preventDefault():void}
export interface SocialWindow {
 webContents:{
  getURL():string;
  executeJavaScriptInIsolatedWorld(worldId:number,scripts:{code:string}[],userGesture?:boolean):Promise<unknown>;
  on(event:string,listener:(event:Preventable,url:string)=>void):unknown;
  setWindowOpenHandler(handler:()=>{action:'deny'}):void;
  session:{setPermissionRequestHandler(handler:(_contents:unknown,_permission:string,callback:(allowed:boolean)=>void)=>void):void;setPermissionCheckHandler(handler:()=>false):void;on(event:string,listener:(event:Preventable)=>void):unknown;clearStorageData():Promise<void>};
 };
 on(event:string,listener:()=>void):unknown;loadURL(url:string):Promise<void>;destroy():void;isDestroyed():boolean;hide():void;show():void;
}
const origins:Record<SocialPlatform,readonly string[]>={linkedin:['www.linkedin.com','linkedin.com'],facebook:['www.facebook.com','business.facebook.com'],x:['x.com','www.x.com']};
const home:Record<SocialPlatform,string>={linkedin:'https://www.linkedin.com/feed/',facebook:'https://www.facebook.com/',x:'https://x.com/home'};
export function socialPartition(scope:SocialScope):string{
 if(!origins[scope.platform]||[scope.workspaceId,scope.userId,scope.accountId].some(v=>!v||v.length>200))throw new Error('invalid_social_scope');
 return `persist:callie-social-${createHash('sha256').update(JSON.stringify([scope.workspaceId,scope.userId,scope.platform,scope.accountId])).digest('hex')}`;
}
export function socialNavigationAllowed(platform:SocialPlatform,value:string):boolean{
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')&&origins[platform].includes(url.hostname);}catch{return false;}
}
function windowOptions(partition:string):SocialWindowOptions{return {show:false,width:1200,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,devTools:false,partition}};}
export function createSocialRuntime(createWindow:(options:SocialWindowOptions)=>SocialWindow){
 let epoch=0;const active=new Map<string,SocialWindow>();
 const sessions=new Map<string,SocialWindow['webContents']['session']>();
 const clearing=new Set<string>();
 const securedSessions=new WeakSet<object>();
 const close=(window:SocialWindow)=>{if(!window.isDestroyed())window.destroy();};
 async function runAccount<T>(scope:SocialScope,run:(session:{window:SocialWindow;isCurrent:()=>boolean})=>Promise<T>,connect:boolean):Promise<T|{ok:false;reason:string}>{
   const partition=socialPartition(scope);if(active.has(partition)||clearing.has(partition))return {ok:false,reason:'account_busy'};
   const generation=epoch;
   const window=createWindow(windowOptions(partition));
   active.set(partition,window);sessions.set(partition,window.webContents.session);
   const isCurrent=()=>generation===epoch&&active.get(partition)===window&&!window.isDestroyed();
   window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
   window.webContents.session.setPermissionCheckHandler(()=>false);
   if(!securedSessions.has(window.webContents.session)){
    window.webContents.session.on('will-download',event=>event.preventDefault());
    securedSessions.add(window.webContents.session);
   }
   for(const event of ['will-navigate','will-redirect'])window.webContents.on(event,(e,url)=>{if(!socialNavigationAllowed(scope.platform,url))e.preventDefault();});
   window.webContents.on('will-attach-webview',e=>e.preventDefault());
   window.on('show',()=>{if(!connect)window.hide();});
   try{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([window.loadURL(home[scope.platform]),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('load_timeout')),30_000);})]);}finally{if(timer)clearTimeout(timer);}
    if(!isCurrent())return {ok:false,reason:'session_changed'};
    if(connect)window.show();
    let operationTimer:ReturnType<typeof setTimeout>|undefined;
    try{
      const result=await Promise.race([run({window,isCurrent}),new Promise<never>((_resolve,reject)=>{operationTimer=setTimeout(()=>reject(new Error('operation_timeout')),connect?600_000:120_000);})]);
      return isCurrent()?result:{ok:false,reason:'session_changed'};
    }finally{if(operationTimer)clearTimeout(operationTimer);}
   }catch{return {ok:false,reason:isCurrent()?'browser_unavailable':'session_changed'};}
   finally{if(active.get(partition)===window)active.delete(partition);close(window);}
  }
 return {
  withAccount<T>(scope:SocialScope,run:(session:{window:SocialWindow;isCurrent:()=>boolean})=>Promise<T>){return runAccount(scope,run,false);},
  /** Only a user-initiated Connect/Reconnect command may invoke this operation. */
  connectAccount<T>(scope:SocialScope,run:(session:{window:SocialWindow;isCurrent:()=>boolean})=>Promise<T>){return runAccount(scope,run,true);},
  async disconnect(scope:SocialScope){
   const partition=socialPartition(scope),window=active.get(partition);
   if(clearing.has(partition))return;
   clearing.add(partition);active.delete(partition);if(window)close(window);
   const cleanupWindow=sessions.has(partition)?null:createWindow(windowOptions(partition));
   try{await (sessions.get(partition)??cleanupWindow!.webContents.session).clearStorageData();}
   finally{if(cleanupWindow)close(cleanupWindow);sessions.delete(partition);clearing.delete(partition);}
  },
  signOut(){epoch++;for(const window of active.values())close(window);active.clear();},
 };
}
