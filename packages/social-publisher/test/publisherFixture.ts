import {createServer,type Server} from 'node:http';
import {chromium,type Browser} from 'playwright';
import type {PublisherLocalBrowser} from '../src/publisherConfig.ts';
import {createPrivatePublisherLaunch} from '../src/publisherNative.ts';
import {attestPublisherSandbox} from '../src/publisherSandbox.ts';

/** Use the same explicit installed-browser selection as the isolated host tests. */
export function publisherFixtureBrowser():PublisherLocalBrowser{
 const executablePath=process.env['FSS_SOCIAL_PUBLISHER_CHROMIUM_PATH'];
 return {kind:'local',...(executablePath?{executablePath}:{})};
}

/** CI-only owned-browser preflight: no account state, credentials or external routes.
 * Keep startup diagnostics here, never in the private production refusal path. */
export async function preflightPublisherFixtureBrowser():Promise<void>{
 const launch=await createPrivatePublisherLaunch(publisherFixtureBrowser().executablePath);
 let browser:Browser|undefined;
 try{
  browser=await chromium.launch(launch.options);
  await attestPublisherSandbox(browser,'local');
 }catch(error){
  throw new Error(`Owned publisher fixture browser preflight failed: ${String(error).slice(0,12000)}`);
 }finally{
  try{await browser?.close();}finally{await launch.close();}
 }
}

export interface PublisherFixture {
 origin:string;close:()=>Promise<void>;
 state:{writes:number;uploads:number;cancelled:number;unknown:boolean;publishOnCancel:boolean;truncate:boolean;text:string;publishAt:string;image:boolean;status:'none'|'scheduled'|'published';account:string};
}
export async function publisherFixture():Promise<PublisherFixture>{
 const state:PublisherFixture['state']={writes:0,uploads:0,cancelled:0,unknown:false,publishOnCancel:false,truncate:false,text:'',publishAt:'',image:false,status:'none',account:'self'};
 const server:Server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const path=new URL(req.url??'/',`http://${req.headers.host}`).pathname;
  if(path==='/fixture/state'){res.setHeader('content-type','application/json');res.end(JSON.stringify(state));return;}
  if(path==='/fixture/upload'){state.uploads++;res.end('{}');return;}
  if(path==='/fixture/schedule'){
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));state.writes++;state.text=body.text;state.publishAt=body.publishAt;state.image=body.image;state.status=state.unknown?'none':'scheduled';res.end('{}');return;
  }
  if(path==='/fixture/delete'){if(state.publishOnCancel){state.status='published';}else{state.status='none';state.cancelled++;}res.end('{}');return;}
  if(path==='/in/me/'){res.writeHead(302,{location:`/in/${state.account}/`});res.end();return;}
  res.setHeader('content-type','text/html');
  res.end(`<!doctype html><html lang="en"><body><main id="root"></main><script>
const root=document.getElementById('root');let image=false;let savedText='';let selectedTime='';
const preview='<img width="200" height="200" alt="Attached image" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22%3E%3Crect width=%22200%22 height=%22200%22 fill=%22green%22/%3E%3C/svg%3E">';
const button=(name,fn,parent=root)=>{const b=document.createElement('button');b.textContent=name;b.onclick=fn;parent.append(b);return b;};
function dialog(){const d=document.createElement('div');d.setAttribute('role','dialog');root.append(d);return d;}
async function rows(parent,published=false){const s=await(await fetch('/fixture/state')).json();if(s.status!==(published?'published':'scheduled'))return;
const row=document.createElement('article');row.dataset.urn='urn:li:activity:123456';const t=document.createElement('div');t.className='update-components-text';t.textContent=s.text;row.append(t);
if(s.truncate){t.textContent=s.text.slice(0,20);const expand=button('See more',()=>{t.textContent=s.text;expand.remove();},row);}
if(!published){const time=document.createElement('time');time.dateTime=s.publishAt;time.textContent=s.publishAt;row.append(time);}else{const a=document.createElement('a');a.href='/feed/update/urn:li:activity:123456/';a.textContent='Post permalink';row.append(a);}
if(s.image)row.insertAdjacentHTML('beforeend',preview);
button('More',()=>{const menu=document.createElement('div');const del=button('Delete',()=>{menu.remove();const confirm=dialog();button('Delete',async()=>{await fetch('/fixture/delete',{method:'POST'});confirm.remove();const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='Scheduled post deleted';root.append(alert);},confirm);},menu);del.setAttribute('role','menuitem');root.append(menu);},row);parent.append(row);}
function schedule(composer){const schedule=dialog();schedule.innerHTML='<label>Date<input aria-label="Date"></label><label>Time<input aria-label="Time"></label>';
button('View all scheduled posts',async()=>{root.innerHTML='';const list=dialog();list.innerHTML='<h2>Scheduled posts</h2>';await rows(list);},schedule);
button('Next',()=>{selectedTime=new Date(schedule.querySelector('[aria-label="Date"]').value+' '+schedule.querySelector('[aria-label="Time"]').value+' UTC').toISOString();schedule.remove();button('Schedule',async()=>{await fetch('/fixture/schedule',{method:'POST',body:JSON.stringify({text:composer.querySelector('[contenteditable]').textContent,publishAt:selectedTime,image})});composer.remove();},composer);},schedule);}
function compose(){const d=dialog();d.innerHTML='<div contenteditable="true" role="textbox"></div><input type="file">';
button('Schedule post',()=>schedule(d),d);
d.querySelector('input').onchange=async()=>{await fetch('/fixture/upload',{method:'POST'});const media=dialog();media.insertAdjacentHTML('beforeend',preview);button('Add alt text',()=>{const alt=dialog();alt.innerHTML='<input aria-label="Alt text">';button('Save',()=>alt.remove(),alt);},media);button('Next',()=>{image=true;media.remove();d.insertAdjacentHTML('beforeend',preview);},media);};}
if(location.pathname==='/login'){root.innerHTML='<form><label>Email<input name="email"></label><label>Password<input type="password" name="password"></label><button style="position:absolute;left:20px;top:60px">Sign in</button></form>';root.querySelector('form').onsubmit=e=>{e.preventDefault();document.cookie='fixtureSession=owned; Path=/; SameSite=Strict';location.href='/in/self/';};}
else if(!document.cookie.includes('fixtureSession=owned'))location.href='/login';
else if(location.pathname.includes('/recent-activity/'))rows(root,true);
else if(location.pathname.startsWith('/in/')){root.innerHTML='<h1>Fictional Founder</h1>';button('Edit intro',()=>{});}
else button('Start a post',compose);
</script></body></html>`);
 });
 const listening=Promise.withResolvers<void>();server.listen(0,'127.0.0.1',listening.resolve);await listening.promise;
 const address=server.address();if(!address||typeof address==='string')throw new Error('fixture_unavailable');
 return {origin:`http://127.0.0.1:${address.port}`,state,close:()=>{const stopped=Promise.withResolvers<void>();server.close(error=>error?stopped.reject(error):stopped.resolve());return stopped.promise;}};
}
