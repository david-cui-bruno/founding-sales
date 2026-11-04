import type {Page,Locator} from 'playwright';
import {createHash} from 'node:crypto';
import type {SocialPublisherAttempt,SocialPublisherObservation} from '@fss/contracts';

const normalize=(text:string)=>text.replace(/\r\n/gu,'\n').trim();
export class PublisherRefusal extends Error {constructor(readonly reason:string){super(reason);this.name='PublisherRefusal';}}
export class LinkedinBrowserRoute {
 constructor(readonly origin='https://www.linkedin.com'){}
 private url(path:string){return `${this.origin}${path}`;}
 async self(page:Page):Promise<{externalId:string;displayName:string}> {
  await page.goto(this.url('/in/me/'),{waitUntil:'domcontentloaded'});
  const url=new URL(page.url());
  if(url.origin!==this.origin||!/^\/in\/[a-zA-Z0-9_%-]+\/?$/u.test(url.pathname)||url.pathname==='/in/me/')throw new PublisherRefusal('session_unavailable');
  const displayName=(await page.locator('main h1').innerText({timeout:10000})).trim().slice(0,200);
  // Own-profile edit control is independent of renderer-supplied identity.
  const edit=page.getByRole('button',{name:/Edit intro|Edit profile/iu}).or(page.getByRole('link',{name:/Edit intro|Edit profile/iu}));
  if(!displayName||await edit.count()!==1)throw new PublisherRefusal('self_account_unverified');
  return {externalId:`${this.origin}${url.pathname.replace(/\/$/u,'')}`,displayName};
 }
 async openComposer(page:Page):Promise<Locator> {
  await page.goto(this.url('/feed/'),{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:/^Start a post/iu}).click();
  const dialog=page.getByRole('dialog').filter({has:page.locator('[contenteditable="true"]')});
  await dialog.waitFor({state:'visible'});
  if(await dialog.getByRole('button',{name:/Schedule post/iu}).count()!==1)throw new PublisherRefusal('native_scheduling_unavailable');
  return dialog;
 }
 async capabilities(page:Page):Promise<void> {
  await this.openComposer(page);
  // Independent existing schedule list is required for reconciliation/cancel.
  await page.goto(this.url('/feed/'),{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:/^Start a post/iu}).click();
  await page.getByRole('button',{name:/Schedule post/iu}).click();
  if(await page.getByRole('button',{name:/View all scheduled posts/iu}).or(page.getByRole('link',{name:/View all scheduled posts/iu})).count()!==1)throw new PublisherRefusal('native_inspection_unavailable');
 }
 async compose(page:Page,attempt:SocialPublisherAttempt,authority:()=>Promise<void>):Promise<void> {
  if(attempt.text===null)throw new PublisherRefusal('attempt_invalid');
  const dialog=await this.openComposer(page);
  await authority();await dialog.locator('[contenteditable="true"]').fill(attempt.text);
  if(attempt.image){
   if(!attempt.image.bytes)throw new PublisherRefusal('image_invalid');
   await authority();
   const payload={name:attempt.image.mime==='image/png'?'image.png':'image.jpg',mimeType:attempt.image.mime,buffer:Buffer.from(attempt.image.bytes)};
   const input=dialog.locator('input[type="file"]');
   if(await input.count()===1)await input.setInputFiles(payload);
   else{
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),dialog.getByRole('button',{name:/Add media|Add a photo|Add photos/iu}).click()]);
    await authority();await chooser.setFiles(payload);
   }
   const media=page.getByRole('dialog').last();
   const alt=media.getByRole('button',{name:/Alt\. text|Alternative text|Add alt text/iu});
   await alt.waitFor({state:'visible'});
   if(await alt.count()!==1)throw new PublisherRefusal('alt_text_unavailable');
   await alt.click();
   await authority();await page.getByRole('textbox',{name:/Alt text|Alternative text/iu}).fill(attempt.image.altText);
   await authority();await page.getByRole('button',{name:/^Save$/iu}).click();
   await authority();await media.getByRole('button',{name:/^Next$|^Done$/iu}).click();
   await this.loadedImage(dialog,1);
  }
  await authority();await dialog.getByRole('button',{name:/Schedule post/iu}).click();
  const schedule=page.getByRole('dialog').last();
  const at=new Date(attempt.publishAt);
  // All contexts use UTC; native displayed date/time is read back before submission.
  const date=schedule.getByRole('textbox',{name:/Date/iu});
  const time=schedule.getByRole('textbox',{name:/Time/iu});
  const dateValue=`${at.getUTCMonth()+1}/${at.getUTCDate()}/${at.getUTCFullYear()}`;
  const hour=at.getUTCHours();const timeValue=`${hour%12||12}:${String(at.getUTCMinutes()).padStart(2,'0')} ${hour>=12?'PM':'AM'}`;
  await authority();await date.fill(dateValue);await authority();await time.fill(timeValue);await time.press('Tab');
  if(normalize(await date.inputValue())!==dateValue||normalize(await time.inputValue()).toUpperCase()!==timeValue)throw new PublisherRefusal('schedule_time_unverified');
  await authority();await schedule.getByRole('button',{name:/^Next$/iu}).click();
  if(normalize(await dialog.locator('[contenteditable="true"]').innerText())!==normalize(attempt.text))throw new PublisherRefusal('text_mismatch');
  await this.loadedImage(dialog,attempt.image?1:0);
  if(await dialog.getByRole('button',{name:/^Schedule$/iu}).count()!==1)throw new PublisherRefusal('schedule_unavailable');
 }
 async finalSubmit(page:Page):Promise<void> {
  const dialog=page.getByRole('dialog').filter({has:page.locator('[contenteditable="true"]')});
  await dialog.getByRole('button',{name:/^Schedule$/iu}).click({timeout:15000});
  // Native acknowledgement only permits readback; it is not scheduled proof.
  await dialog.waitFor({state:'hidden',timeout:15000});
 }
 private async loadedImage(root:Locator,count:number):Promise<boolean> {
  const selector='img:not([class*="EntityPhoto"]):not([class*="avatar"]):not([class*="profile-photo"])';
  if(count>0){
   const element=await root.elementHandle();if(!element)throw new PublisherRefusal('image_preview_unverified');
   try{await root.page().waitForFunction(({element,count,selector})=>Array.from(element.querySelectorAll<HTMLImageElement>(selector)).filter(node=>node.complete&&node.naturalWidth>0&&node.naturalHeight>0).length>=count,{element,count,selector},{timeout:10000});}
   finally{await element.dispose();}
  }
  const images=root.locator(selector).filter({visible:true});
  // Select media images, never the author avatar.
  const loaded=await images.evaluateAll(async nodes=>{
   await Promise.all(nodes.map(async node=>{if(node instanceof HTMLImageElement)try{await node.decode();}catch{/* A broken image never qualifies as loaded. */}}));
   return nodes.filter(node=>node instanceof HTMLImageElement&&node.naturalWidth>0&&node.naturalHeight>0&&node.complete).length;
  });
  if(loaded!==count)throw new PublisherRefusal('image_preview_unverified');
  return true;
 }
 private async scheduled(page:Page):Promise<void> {
  await page.goto(this.url('/feed/'),{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:/^Start a post/iu}).click();
  await page.getByRole('button',{name:/Schedule post/iu}).click();
  await page.getByRole('button',{name:/View all scheduled posts/iu}).or(page.getByRole('link',{name:/View all scheduled posts/iu})).click();
  await page.getByRole('dialog').filter({has:page.getByRole('heading',{name:/Scheduled posts/iu})}).waitFor();
  await page.waitForLoadState('networkidle',{timeout:10000});
 }
 private async match(root:Locator,attempt:SocialPublisherAttempt,receiptId:string|null,scheduled:boolean):Promise<{receiptId:string;loadedPreview:boolean;permalink:string|null}|null> {
  const matches: {receiptId:string;loadedPreview:boolean;permalink:string|null}[]=[];
  // Native URNs on independently loaded rows are stable remote identity, not local IDs.
  const rows=root.locator('[data-urn^="urn:li:activity:"], [data-urn^="urn:li:share:"]');
  const count=await rows.count();if(count>100)throw new PublisherRefusal('readback_incomplete');
  for(let index=0;index<count;index++){
   const row=rows.nth(index);const id=await row.getAttribute('data-urn');if(!id||(receiptId!==null&&id!==receiptId))continue;
   const expand=row.getByRole('button',{name:/see more|show more|expand post/iu});
   if(await expand.count()>1)continue;
   if(await expand.count()===1)await expand.click();
   const text=row.locator('.update-components-text');
   if(await text.count()!==1)continue;
   const observed=normalize(await text.innerText());
   if(attempt.text!==null?observed!==normalize(attempt.text):createHash('sha256').update(observed).digest('hex')!==attempt.textSHA256)continue;
   if(scheduled){
    const time=row.locator('time[datetime]');
    if(await time.count()!==1||Date.parse((await time.getAttribute('datetime'))??'')!==Date.parse(attempt.publishAt))continue;
   }
   if(!scheduled&&receiptId===null){
    // Never mistake an older identical post for this uncertain first submission.
    const time=row.locator('time[datetime]');if(await time.count()!==1)continue;
    const publishedAt=Date.parse((await time.getAttribute('datetime'))??''),target=Date.parse(attempt.publishAt);
    if(!Number.isFinite(publishedAt)||publishedAt<target||publishedAt>target+300000||publishedAt>Date.now()+60000)continue;
   }
   let loadedPreview=false;
   try{loadedPreview=await this.loadedImage(row,attempt.image?1:0);}catch{continue;}
   const link=row.locator('a[href*="/feed/update/"]');let permalink:string|null=null;
   if(!scheduled&&await link.count()>0){const value=new URL((await link.first().getAttribute('href'))??'',this.origin);if(value.origin===this.origin)permalink=value.toString();}
   matches.push({receiptId:id,loadedPreview,permalink});
  }
  return matches.length===1?matches[0]!:null;
 }
 async inspect(page:Page,attempt:SocialPublisherAttempt,receiptId:string|null):Promise<Pick<SocialPublisherObservation,'state'|'receiptId'|'loadedPreview'|'permalink'>|null> {
  await this.scheduled(page);
  const scheduled=await this.match(page.getByRole('dialog').last(),attempt,receiptId,true);
  if(scheduled)return {state:'scheduled',...scheduled};
  // Missing schedule is never cancelled/absent proof: independently inspect own activity.
  await page.goto(`${attempt.binding.externalId}/recent-activity/all/`,{waitUntil:'domcontentloaded'});
  await page.waitForLoadState('networkidle',{timeout:10000});
  const published=await this.match(page.locator('main'),attempt,receiptId,false);
  return published?{state:'published',...published}:null;
 }
 async cancel(page:Page,attempt:SocialPublisherAttempt,receiptId:string,authority:()=>Promise<void>):Promise<boolean> {
  await this.scheduled(page);
  const root=page.getByRole('dialog').last();
  const matched=await this.match(root,attempt,receiptId,true);if(!matched)return false;
  // URNs are validated before building this selector; select only the exact matched native row.
  const exact=root.locator(`[data-urn="${receiptId}"]`);
  await exact.getByRole('button',{name:/More|Open control menu/iu}).click();
  await authority();await page.getByRole('menuitem',{name:/Delete/iu}).click();
  await authority();
  await page.getByRole('dialog').last().getByRole('button',{name:/^Delete$/iu}).click();
  // A witnessed exact-delete acknowledgement followed by fresh independent absence is required.
  await page.getByRole('alert').filter({hasText:/scheduled post.*deleted|post.*deleted/iu}).waitFor({timeout:10000});
  await this.scheduled(page);
  return await root.locator(`[data-urn="${receiptId}"]`).count()===0;
 }
}
