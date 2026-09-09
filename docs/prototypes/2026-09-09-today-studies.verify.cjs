const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const projectRequire=require('node:module').createRequire(path.join(process.cwd(),'package.json'));
const {chromium}=projectRequire('playwright');
const {default:AxeBuilder}=projectRequire('@axe-core/playwright');
const output=process.env.FSS_STUDY_RESULTS||path.join(require('node:os').homedir(),'.jcode/scratch/fss-today-variations-20260909');
fs.mkdirSync(output,{recursive:true});
const checks=[];
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage();const errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/^https?:/.test(request.url()))requests.push(request.url());});
  await context.route(/^https?:/,route=>route.abort());
  const url=pathToFileURL(path.resolve(process.env.FSS_STUDY_TARGET||'docs/prototypes/2026-09-09-today-studies.html')).href;
  await page.goto(url);assert.equal(await page.locator('[data-item]').count(),8);assert.deepEqual(errors,[]);checks.push('initial render');
  assert.equal(await page.locator('button[data-study]').count(),3,'three approved visual study controls must exist');
  assert.equal(await page.locator('button[data-study=native]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#app').evaluate(node=>node.classList.contains('compact')),true,'compact is the default');
  const original=await page.locator('#detail').innerText();
  for(const study of ['index','warm','native']){
   await page.locator(`button[data-study=${study}]`).click();
   assert.equal(await page.locator('html').getAttribute('data-study'),study);
   assert.equal(await page.locator('button[data-study][aria-pressed=true]').count(),1);
   assert.equal(await page.locator('#detail').innerText(),original,'same content across studies');
  }
  await page.locator('button[data-study=native]').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.study),'index');
  assert.equal(await page.locator('html').getAttribute('data-study'),'index');
  await page.keyboard.press('End');assert.equal(await page.locator('html').getAttribute('data-study'),'warm');
  await page.keyboard.press('Home');assert.equal(await page.locator('html').getAttribute('data-study'),'native');
  checks.push('three compact studies, identical content and keyboard selection');
  console.log('layout',await page.evaluate(()=>({queueHeight:document.getElementById('queue').clientHeight,queueScroll:document.getElementById('queue').scrollHeight,lastHeading:[...document.querySelectorAll('.lane-heading')].at(-1).getBoundingClientRect().bottom,viewport:innerHeight})));
  assert.equal(await page.evaluate(()=>document.querySelector('[data-item=owen]').getBoundingClientRect().bottom<=document.getElementById('queue').getBoundingClientRect().bottom),true,'all three lanes and both meetings visible');checks.push('all three lane groups visible');await page.screenshot({path:path.join(output,'calls-light-1440.png'),fullPage:true});
  await page.locator('[data-item=jamila]').focus();await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.item),'ellis');await page.keyboard.press('Enter');assert.equal(await page.locator('#selected-title').textContent(),'Ellis Brooks');assert.equal(await page.evaluate(()=>document.activeElement.dataset.item),'ellis');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.item),'maya');checks.push('queue keyboard and focus after selection');
  await page.locator('[data-item=nora]').click();
  const edited='Hi Nora,\n\nYour coordinator should stay central to the discussion. Let’s walk through the current handoff first.\n\nDavid';
  await page.locator('#message').fill(edited);await page.locator('#subject').fill('A focused next conversation');
  const textarea=await page.$('#message');
  await textarea.evaluate(node=>{node.focus();node.setSelectionRange(12,32);node.scrollTop=24;});
  const caret=await textarea.evaluate(node=>[node.selectionStart,node.selectionEnd]);
  const scrollPane=await page.$('.detail-content');await scrollPane.evaluate(node=>node.scrollTop=60);const scrollTop=await scrollPane.evaluate(node=>node.scrollTop);
  for(const study of ['index','warm','native']){
   await page.locator(`button[data-study=${study}]`).click();
   assert.equal(await textarea.evaluate(node=>node===document.getElementById('message')),true,'switch must retain real editor node');
   assert.equal(await page.locator('#message').inputValue(),edited);
   assert.deepEqual(await textarea.evaluate(node=>[node.selectionStart,node.selectionEnd]),caret,'caret stays intact');
   assert.equal(await scrollPane.evaluate((node,top)=>node.scrollTop===Math.min(top,node.scrollHeight-node.clientHeight),scrollTop),true,'scroll position stays intact');
  }
  await page.locator('button[data-study=warm]').click();await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-study'),'warm','style survives reload');
  assert.equal(await page.locator('#selected-title').textContent(),'Nora Ellis');
  assert.equal(await page.locator('#message').inputValue(),edited);
  await page.locator('button[data-study=native]').click();
  const freshTextarea=await page.$('#message');
  checks.push('editor node, caret, content and style persistence');
  await page.setViewportSize({width:1050,height:900});
  await page.locator('button[data-study=native]').click();
  const roundTripPane=await page.$('.detail-content');
  await roundTripPane.evaluate(node=>node.scrollTop=node.scrollHeight);
  const originalOffset=await roundTripPane.evaluate(node=>node.scrollTop);
  await page.locator('button[data-study=index]').click();
  const indexMax=await roundTripPane.evaluate(node=>node.scrollHeight-node.clientHeight);
  assert.ok(originalOffset>indexMax,'fixture must actually force scroll clamping');
  await page.locator('button[data-study=native]').click();
  assert.equal(await roundTripPane.evaluate(node=>node.scrollTop),originalOffset,'returning to the taller study restores the unclamped reading offset');
  await page.locator('button[data-study=index]').click();
  await roundTripPane.evaluate(node=>node.scrollTop=17);
  await page.locator('button[data-study=native]').click();
  assert.equal(await roundTripPane.evaluate(node=>node.scrollTop),17,'new user scrolling supersedes the prior offset');
  await page.setViewportSize({width:1440,height:900});
  checks.push('scroll round-trip survives a shorter study');

await page.locator('#preview-toggle').click();await page.locator('#theme').selectOption('dark');await page.locator('#density').selectOption('compact');await page.locator('#refresh').click();assert.equal(await freshTextarea.evaluate(node=>node===document.getElementById('message')),true);assert.equal(await page.locator('#message').inputValue(),edited);checks.push('stable editor DOM through preferences and refresh');
  await page.locator('[data-item=maya]').click();await page.locator('[data-item=nora]').click();assert.equal(await page.locator('#message').inputValue(),edited);
  await page.reload();assert.equal(await page.locator('#selected-title').textContent(),'Nora Ellis');assert.equal(await page.locator('#message').inputValue(),edited);checks.push('selection and draft persist through switch/reload');
  await page.locator('#approve').click();assert.match(await page.locator('#approval-state').textContent(),/No message was sent/);assert.match(await page.locator('[data-item=nora]').textContent(),/Approved · not sent/);await page.locator('#message').fill(edited+'\nP.S. No commitments assumed.');assert.equal(await page.locator('#approval-state').count(),0);assert.equal(await page.locator('#approve').isEnabled(),true);checks.push('approval is not delivery; edits invalidate approval');
  const current=await page.locator('#message').inputValue();await page.locator('[data-action=new-reply]').click();assert.equal(await page.locator('#approve').isDisabled(),true);assert.equal(await page.locator('#message').inputValue(),current);await page.locator('[data-action=review-reply]').click();await page.locator('[data-action=ack-reply]').click();assert.equal(await page.locator('#approve').isEnabled(),true);checks.push('new-context hold preserves edited text');
  await page.locator('#preview-toggle').click();await page.locator('#connection').selectOption('offline');assert.equal(await page.locator('#approve').isDisabled(),true);assert.equal(await page.locator('#message').getAttribute('readonly'),'');assert.equal(await page.locator('#message').inputValue(),current);await page.locator('[data-item=jamila]').click();assert.equal(await page.locator('[data-action=call]').isDisabled(),true);await page.locator('#connection').selectOption('phone');assert.equal(await page.locator('[data-action=call]').isDisabled(),true);await page.locator('[data-item=nora]').click();assert.equal(await page.locator('#approve').isEnabled(),true);checks.push('offline and phone-only setup are distinct');
  await page.locator('#connection').selectOption('ready');await page.locator('[data-item=jamila]').click();await page.locator('[data-action=call]').click();assert.equal(await page.locator('.row-done').count(),0);await page.locator('[data-action=handoff]').click();assert.equal(await page.locator('#save-outcome').isDisabled(),true);await page.getByRole('button',{name:'Connected',exact:true}).click();await page.locator('#outcome-note').fill('Fictional recap only.');await page.locator('#save-outcome').click();assert.match(await page.locator('#detail').textContent(),/Outcome reported: Connected/);await page.locator('#undo').click();assert.equal(await page.locator('#detail [data-action=call]').count(),1);checks.push('handoff is not connected; explicit outcome and undo');
  await page.locator('[data-item=marcus]').click();await page.locator('[data-action=copy]').click();assert.equal(await page.locator('[data-item=marcus] .row-done').count(),0);await page.locator('[data-action=profile]').click();await page.getByRole('button',{name:'Back to the draft',exact:true}).click();assert.equal(await page.locator('[data-item=marcus] .row-done').count(),0);await page.locator('[data-action=manual-outcome]').click();await page.getByRole('button',{name:'Sent manually',exact:true}).click();await page.locator('#save-outcome').click();assert.match(await page.locator('[data-item=marcus]').textContent(),/Reported sent manually/);checks.push('manual LinkedIn copy/open do not imply sent');for(const [choice,label,note] of [['Received a reply','Reply reported','Please check back next month.'],['Asked not to be contacted','Opt-out reported','No further contact requested.'],['Not sent','Reported not sent','Paused before sending.']]){await page.locator('[data-action=manual-outcome]').click();await page.getByRole('button',{name:choice,exact:true}).click();await page.locator('#outcome-note').fill(note);await page.locator('#save-outcome').click();assert.match(await page.locator('[data-item=marcus]').textContent(),new RegExp(label));assert.match(await page.locator('#detail').textContent(),new RegExp(note));assert.equal(await page.locator('[data-action=copy]').isDisabled(),choice!=='Not sent');await page.reload();assert.match(await page.locator('#detail').textContent(),new RegExp(note));}checks.push('manual reply, opt-out and non-send recap persistence');
  await page.locator('[data-item=rosa]').click();assert.match(await page.locator('.meeting-status').textContent(),/Calendar event createdAttendee accepted/);await page.locator('[data-item=owen]').click();assert.match(await page.locator('.meeting-status').textContent(),/Invite response pending/);checks.push('calendar and attendee status distinct');
  await page.getByRole('button',{name:'Campaigns',exact:true}).click();assert.match(await page.locator('#modal').textContent(),/Requested email only/);await page.getByRole('button',{name:'Back to Today',exact:true}).click();checks.push('campaign context on demand');
  await page.locator('#reset').click();await page.locator('#toast-close').click();
  const shape=[];
  for(const study of ['native','index','warm']){
   await page.locator(`button[data-study=${study}]`).click();await page.locator('[data-item=jamila]').click();
   shape.push(await page.evaluate(()=>{
    const d=getComputedStyle(document.querySelector('.detail')),b=getComputedStyle(document.querySelector('.brief-block')),q=getComputedStyle(document.querySelector('.ask'));
    return {shadow:d.boxShadow,radius:d.borderRadius,layout:b.display,questionFont:q.fontFamily};
   }));
  }
  assert.notEqual(shape[0].shadow,'none');assert.equal(shape[1].shadow,'none');
  assert.equal(shape[1].layout,'grid');assert.match(shape[2].questionFont,/Georgia|serif/);
  assert.equal(new Set(shape.map(s=>JSON.stringify(s))).size,3,'not merely color themes');
  checks.push('structurally distinct sheet, index and editorial treatments');
  const axeResults=[];
  for(const study of ['native','index','warm'])for(const width of [1440,1050])for(const theme of ['light','dark']){
   await page.locator(`button[data-study=${study}]`).click();
   await page.setViewportSize({width,height:900});
   if(await page.locator('#preview-controls').isHidden())await page.locator('#preview-toggle').click();await page.locator('#theme').selectOption(theme);await page.locator('#density').selectOption('compact');await page.locator('#preview-toggle').click();
   for(const id of ['jamila','nora','rosa']){
    await page.locator(`[data-item=${id}]`).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`overflow ${study} ${width} ${theme} ${id}`);
    assert.equal(await page.evaluate(()=>document.querySelector('[data-item=owen]').getBoundingClientRect().bottom<=document.getElementById('queue').getBoundingClientRect().bottom+1),true,`all lanes visible ${study} ${width} ${id}`);
    assert.equal(await page.evaluate(()=>{const a=document.querySelector('.action-area').getBoundingClientRect(),d=document.getElementById('detail').getBoundingClientRect();return a.bottom<=d.bottom&&a.top>=d.top;}),true,'primary action remains inside detail');if(id==='rosa')assert.equal(await page.evaluate(()=>document.querySelector('.agenda li:last-child').getBoundingClientRect().bottom<=document.querySelector('.detail-content').getBoundingClientRect().bottom),true,`meeting agenda visible ${study} ${width}`);await page.screenshot({path:path.join(output,`${study}-${id}-${theme}-${width}.png`),fullPage:true});
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();const problems=result.violations.filter(v=>['critical','serious'].includes(v.impact));axeResults.push({study,width,theme,id,violations:problems.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))});
   }
  }
  fs.writeFileSync(path.join(output,'axe.json'),JSON.stringify(axeResults,null,2));assert.equal(axeResults.flatMap(r=>r.violations).length,0,'serious accessibility findings; see axe.json');checks.push('all three studies: 1440/1050 light/dark calls/email/meetings and accessibility');
  await page.locator('#preview-toggle').click();await page.locator('#day').selectOption('quiet');assert.equal(await page.locator('[data-item]').count(),2);assert.match(await page.locator('#queue').textContent(),/Nothing needs your attention/);await page.locator('#density').selectOption('compact');await page.screenshot({path:path.join(output,'quiet-compact.png'),fullPage:true});checks.push('quiet day and compact alternative');
  await page.locator('#reset').click();await page.locator('#toast-close').click();await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.locator('[data-item=nora]').click();assert.equal(await page.locator('#message').isVisible(),true);await page.getByRole('button',{name:'Back to Today',exact:true}).click();assert.equal(await page.locator('#queue').isVisible(),true);await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});checks.push('narrow screen queue/detail navigation');
  assert.equal(await page.locator('[data-action=today] .nav-icon').isVisible(),true);const mobileAxe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(mobileAxe.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[]);checks.push('mobile navigation icons and accessibility');
  for(const study of ['native','index','warm']){
   await page.locator(`button[data-study=${study}]`).click();await page.locator('[data-item=nora]').click();
   assert.equal(await page.locator('#message').isVisible(),true,`mobile editor reachable in ${study}`);
   assert.equal(await page.locator('#approve').isVisible(),true,`mobile approval reachable in ${study}`);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`mobile overflow ${study}`);
   const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
   assert.deepEqual(result.violations.filter(v=>['critical','serious'].includes(v.impact)).map(v=>v.id),[],`mobile accessibility ${study}`);
   await page.getByRole('button',{name:'Back to Today',exact:true}).click();
  }
  checks.push('all three mobile styles keep editor, actions and return navigation reachable');assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);checks.push('no browser script errors or external network requests');
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,requests},null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
