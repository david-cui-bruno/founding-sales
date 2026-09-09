import { test, expect, type Page } from 'playwright/test';
import { build } from 'esbuild';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import type {} from '../fixtures/nativeDeskBrowser';

// This exercises real renderer components, not Electron IPC or live services.
// The entire API is the explicit no-IO fixture. All browser requests are blocked.
let javascript: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: [path.resolve('tests/fixtures/nativeDeskBrowser.tsx')],
    outdir: 'browser-fixture', bundle: true, write: false, format: 'iife',
    jsx: 'automatic', loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  javascript = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});
async function mount(page: Page) {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const fixtureUrl = 'http://127.0.0.1:41837/native-desk-fixture';
  await page.route('**/*', route => {
    if (route.request().url() === fixtureUrl && route.request().isNavigationRequest()) {
      return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><title>Native Desk isolated renderer acceptance</title></head><body><div id="root"></div></body></html>'});
    }
    requests.push(route.request().url()); return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  // Intercepted loopback document gives genuine secure-context Web Crypto, as
  // Electron's local app origin does, without a server or any network request.
  await page.goto(fixtureUrl);
  expect(await page.evaluate(() => isSecureContext && typeof crypto.randomUUID === 'function')).toBe(true);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: javascript });
  await expect(page.getByTestId('native-desk')).toBeVisible();
  return { errors, requests };
}
const methods = (page: Page) => page.evaluate(() => window.nativeDeskBrowser.fixture.calls.map(call => call.method));
async function assertClean(page: Page, state: {errors: string[]; requests: string[]}) {
  expect(state.errors).toEqual([]);
  expect(state.requests).toEqual([]);
  expect(await methods(page)).not.toContain('forbidden');
}
test('real Native Desk themes, geometry, selection and unchanged editor DOM', async ({page}, testInfo) => {
  const state = await mount(page);
  expect((await methods(page)).every(method => ['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments'].includes(method))).toBe(true);
  const email = page.getByRole('button', { name: 'Email · Account A', exact: true });
  await email.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Email · Account B', exact: true })).toBeFocused();
  await page.keyboard.press('k');
  await expect(email).toBeFocused();
  await page.keyboard.press('Enter');
  const body = page.getByRole('textbox', {name:'Email body'});
  await expect(body).toHaveValue('Saved note for a');
  await body.fill('My retained local edit for account A');
  await body.evaluate(el => { el.focus(); (el as HTMLTextAreaElement).setSelectionRange(6, 12); el.setAttribute('data-node-marker', 'original'); });
  for (const width of [1440,1050]) {
    await page.setViewportSize({width,height:width===1440?900:700});
    for (const theme of ['light','dark'] as const) {
      for (const density of ['comfortable','compact'] as const) {
        await page.evaluate(({theme,density}) => {window.nativeDeskBrowser.preferences(theme,density);window.nativeDeskBrowser.rerender();window.nativeDeskBrowser.refresh();}, {theme,density});
        await expect(body).toHaveAttribute('data-node-marker','original');
        expect(await body.evaluate(el => [(el as HTMLTextAreaElement).selectionStart,(el as HTMLTextAreaElement).selectionEnd])).toEqual([6,12]);
        await expect(body).toHaveValue('My retained local edit for account A');
        const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, headings:[...document.querySelectorAll('.native-desk__lane h2')].map(el=>({text:el.textContent,y:el.getBoundingClientRect().bottom})),height:innerHeight }));
        expect(geometry.overflow).toBe(false);
        expect(geometry.headings).toHaveLength(3);
        for (const heading of geometry.headings) expect(heading.y,`${heading.text} visible at ${width}/${theme}/${density}`).toBeLessThan(geometry.height);
        const axe = await new AxeBuilder({page}).analyze();
        expect(axe.violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
        await page.screenshot({path:testInfo.outputPath(`native-${width}-${theme}-${density}.png`),fullPage:true});
      }
    }
  }
  await page.evaluate(() => window.nativeDeskBrowser.preferences('system','compact'));
  for (const colorScheme of ['light','dark'] as const) {
    await page.emulateMedia({colorScheme});
    await expect(page.locator('html')).toHaveAttribute('data-theme',colorScheme);
    await expect(body).toHaveAttribute('data-node-marker','original');
    await expect(body).toBeFocused();
    expect(await body.evaluate(el=>[(el as HTMLTextAreaElement).selectionStart,(el as HTMLTextAreaElement).selectionEnd])).toEqual([6,12]);
    const axe = await new AxeBuilder({page}).analyze();
    expect(axe.violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
  }
  expect(await page.evaluate(()=>localStorage.getItem('callie.theme'))).toBe('system');
  await page.getByRole('button',{name:'Email · Account B',exact:true}).click();
  await expect(body).toHaveValue('Saved note for b');
  await email.click();
  await expect(body).toHaveValue('My retained local edit for account A');
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await expect(body).toHaveCount(0);
  await email.click();
  await expect(body).toHaveValue('My retained local edit for account A');
  await page.keyboard.press('Escape');
  await expect(body).toHaveCount(0);
  await expect(email).toBeFocused();
  await assertClean(page,state);
});

test('explicit exact email approval stays separate from sending', async ({page}) => {
  const state = await mount(page);
  await page.getByRole('button',{name:'Email · Account A',exact:true}).click();
  await page.getByText('Approval permission',{exact:true}).click();
  await page.getByRole('checkbox').check();
  const expiry = new Date(Date.now()+86400000).toISOString().slice(0,16);
  await page.getByLabel('Approval expiry').fill(expiry);
  await page.getByRole('textbox',{name:'Email body'}).fill('The exact draft I approve.');
  const approve = page.getByRole('button',{name:'Approve email',exact:true});
  await expect(approve).toBeEnabled();
  await approve.scrollIntoViewIfNeeded();
  const target = await approve.boundingBox();
  expect(target).not.toBeNull();
  await page.mouse.move(target!.x+target!.width/2,target!.y+target!.height/2);
  await page.mouse.down();
  await page.evaluate(()=>window.nativeDeskBrowser.refresh());
  await expect(approve).toBeEnabled();
  const after = await approve.boundingBox();
  expect(after).toEqual(target);
  await page.mouse.up();
  await expect(page.getByText(/Approval: pending preflight/)).toBeVisible();
  const calls = await page.evaluate(()=>window.nativeDeskBrowser.fixture.calls);
  expect(calls.filter(call=>call.method==='approveRequestedFollowup')).toHaveLength(1);
  const editIndex = calls.findIndex(call=>call.method==='editRequestedFollowup');
  const approveIndex = calls.findIndex(call=>call.method==='approveRequestedFollowup');
  expect(editIndex).toBeGreaterThan(-1); expect(approveIndex).toBeGreaterThan(editIndex);
  expect(calls[approveIndex].input).toMatchObject({draft:{body:'The exact draft I approve.',revision:2},expectedRemoteDraftRevision:2});
  expect(calls.some(call=>call.method==='getRequestedFollowup')).toBe(false);
  await assertClean(page,state);
});

test('manual LinkedIn outcome stays separate from opening and copying', async ({page}) => {
  const state = await mount(page);
  await page.getByRole('button',{name:'Manual LinkedIn · Account A',exact:true}).click();
  const note = page.getByRole('textbox',{name:'LinkedIn note'});
  await note.fill('A human-reviewed manual note.');
  await page.getByRole('button',{name:'Begin manual step',exact:true}).click();
  await expect(page.getByRole('button',{name:'Begin manual step',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Copy note',exact:true}).click();
  await page.getByRole('button',{name:'Open LinkedIn',exact:true}).click();
  expect((await methods(page)).filter(method=>method==='linkedin.reportOutcome')).toHaveLength(0);
  await page.getByRole('combobox',{name:'Manual outcome'}).selectOption('human_reported_sent');
  await page.getByRole('button',{name:'Record outcome',exact:true}).click();
  expect((await methods(page)).filter(method=>method==='linkedin.reportOutcome')).toHaveLength(1);
  await assertClean(page,state);
});

async function installPendingRecoveryFixture(page: Page, kind: 'manual' | 'requested') {
  await page.evaluate(kind=>{
    type Mutable<T> = { -readonly [K in keyof T]: T[K] };
    const fixture = window.nativeDeskBrowser.fixture;
    type Receipt = Parameters<typeof fixture.setSnapshot>[0]['ownerStatus'][number]['pendingCommands'][number];
    const reflect = (receipt: Receipt | null) => {
      const snapshot = fixture.snapshot();
      const owner = snapshot.ownerStatus.find(item=>item.accountId==='a');
      if (!owner) throw Error('Missing fixture owner');
      owner.pendingCommands = receipt ? [structuredClone(receipt)] : [];
      owner.status = receipt ? 'pending' : 'owner_applied';
      fixture.setSnapshot(snapshot);
    };
    const delegation: Mutable<typeof fixture.api.delegation> = fixture.api.delegation;
    let syncCalls=0;
    delegation.sync = async () => {
      fixture.calls.push({method:'delegation.sync'});
      if (++syncCalls===1 && kind==='manual') throw Error('Fixture owner sync unavailable');
      // This models a durable owner event applied to local storage. The UI must
      // reread it, not infer cleared state from the untrusted report counts.
      reflect(null);
      return {applied:1,gaps:0,cursor:'fixture-cursor',ownerFresh:true};
    };
    if (kind==='manual') {
      const api: Mutable<typeof fixture.api.linkedin> = fixture.api.linkedin;
      const original = api.reportOutcome;
      let reports=0;
      api.reportOutcome = async input => {
        const result=await original(input);
        if (++reports===1) {reflect(result.receipt);return result;}
        reflect(null);
        return {...result,receipt:{...result.receipt,status:'applied'}};
      };
    } else {
      const original=delegation.approveRequestedFollowup;
      let approvals=0;
      delegation.approveRequestedFollowup=async input=>{
        const result=await original(input);
        if (++approvals===1) {reflect(result.receipt);throw Error('Fixture lost pending approval response');}
        reflect(null);
        return {...result,state:'needs_review',receipt:{...result.receipt,status:'rejected',reason:'Fixture terminal rejection'}};
      };
    }
  },kind);
}

test('real pending manual receipt can be explicitly reconciled without unholding new work or syncing automatically', async ({page}) => {
  const state=await mount(page);
  await installPendingRecoveryFixture(page,'manual');
  await page.getByRole('button',{name:'Manual LinkedIn · Account A',exact:true}).click();
  await page.getByRole('button',{name:'Begin manual step',exact:true}).click();
  await page.getByRole('combobox',{name:'Manual outcome'}).selectOption('not_sent');
  await page.getByRole('button',{name:'Record outcome',exact:true}).click();
  await page.evaluate(()=>window.nativeDeskBrowser.refresh());
  await expect(page.getByRole('button',{name:'Copy note',exact:true})).toBeDisabled();
  expect((await methods(page)).filter(method=>method==='delegation.sync')).toHaveLength(0);
  await page.locator('.native-desk__connection > summary').click();
  const recheck=page.getByRole('button',{name:'Reconcile queued commands',exact:true});
  await expect(recheck).toBeEnabled();
  await page.evaluate(()=>{
    window.nativeDeskBrowser.fixture.setConfiguration({state:'paused',workspaceId:'ws',endpoint:'https://owner.fixture.invalid',configuration:{revision:2,configuration:{version:1,state:'paused',research:null},updatedAt:new Date().toISOString()}});
    window.nativeDeskBrowser.refresh();
  });
  await expect(recheck).toBeDisabled();
  expect((await methods(page)).filter(method=>method==='delegation.sync')).toHaveLength(0);
  await page.evaluate(()=>{
    window.nativeDeskBrowser.fixture.setConfiguration({state:'active',workspaceId:'ws',endpoint:'https://owner.fixture.invalid',configuration:{revision:3,configuration:{version:1,state:'active',research:null},updatedAt:new Date().toISOString()}});
    window.nativeDeskBrowser.refresh();
  });
  await expect(recheck).toBeEnabled();
  await recheck.click();
  await expect.poll(async()=>(await methods(page)).filter(method=>method==='delegation.sync').length).toBe(1);
  await expect(page.getByRole('button',{name:'Copy note',exact:true})).toBeDisabled();
  expect((await methods(page)).filter(method=>method==='linkedin.reportOutcome')).toHaveLength(1);
  await expect(recheck).toBeEnabled();
  await recheck.click();
  const retry=page.getByRole('button',{name:'Retry retained outcome',exact:true});
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByText('Human outcome receipt: applied.',{exact:true})).toBeVisible();
  const reports=await page.evaluate(()=>window.nativeDeskBrowser.fixture.calls.filter(call=>call.method==='linkedin.reportOutcome'));
  expect(reports).toHaveLength(2);expect(reports[1].input).toEqual(reports[0].input);
  expect((await methods(page)).filter(method=>method==='delegation.sync')).toHaveLength(2);
  expect((await methods(page)).filter(method=>['linkedin.open','linkedin.copy'].includes(method))).toHaveLength(0);
  await assertClean(page,state);
});

test('a lost requested approval with a persisted pending receipt keeps exact identity through explicit owner recheck', async ({page}) => {
  const state=await mount(page);
  await installPendingRecoveryFixture(page,'requested');
  await page.getByRole('button',{name:'Email · Account A',exact:true}).click();
  await page.getByText('Approval permission',{exact:true}).click();
  await page.getByRole('checkbox').check();
  await page.getByLabel('Approval expiry').fill(new Date(Date.now()+86400000).toISOString().slice(0,16));
  await page.getByRole('button',{name:'Approve email',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry same approval',exact:true})).toBeVisible();
  await page.evaluate(()=>window.nativeDeskBrowser.refresh());
  await expect(page.getByRole('button',{name:'Approve email',exact:true})).toBeDisabled();
  expect((await methods(page)).filter(method=>method==='delegation.sync')).toHaveLength(0);
  await page.locator('.native-desk__connection > summary').click();
  await page.getByRole('button',{name:'Reconcile queued commands',exact:true}).click();
  const retry=page.getByRole('button',{name:'Retry same approval',exact:true});
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByText(/Approval: needs review/)).toBeVisible();
  const approvals=await page.evaluate(()=>window.nativeDeskBrowser.fixture.calls.filter(call=>call.method==='approveRequestedFollowup'));
  expect(approvals).toHaveLength(2);expect(approvals[1].input).toEqual(approvals[0].input);
  expect((await methods(page)).filter(method=>method==='delegation.sync')).toHaveLength(1);
  expect((await methods(page)).filter(method=>method==='editRequestedFollowup')).toHaveLength(1);
  await assertClean(page,state);
});

test('accounts, frozen campaigns, real meeting status and held refresh preserve boundaries', async ({page}) => {
  const state = await mount(page);
  await page.getByRole('button',{name:'Call · Account A',exact:true}).click();
  await expect(page.getByText(/Call handoff unavailable in this account view/)).toBeVisible();
  await page.locator('[data-row-key="meeting:a:meeting-a"]').click();
  await expect(page.getByText(/Attendance not recorded/)).toBeVisible();
  await page.evaluate(()=>window.nativeDeskBrowser.navigate('accounts'));
  await expect(page.getByRole('heading',{name:'Accounts',exact:true,level:1})).toBeVisible();
  await page.locator('[data-row-key="account:a"]').click();
  await expect(page.getByText('12 managed buildings')).toBeVisible();
  await page.evaluate(()=>window.nativeDeskBrowser.navigate('campaigns'));
  await page.locator('[data-row-key="campaign:version"]').click();
  await expect(page.getByText(/Lifetime channel caps/).first()).toBeVisible();
  expect((await methods(page)).every(method=>['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments'].includes(method))).toBe(true);
  await page.evaluate(()=>window.nativeDeskBrowser.navigate('today'));
  await page.getByRole('button',{name:'Email · Account A',exact:true}).click();
  const body = page.getByRole('textbox',{name:'Email body'});
  await body.fill('Still here when refresh fails');
  await page.evaluate(()=>{window.nativeDeskBrowser.fixture.api.daily.get=async()=>{throw Error('fixture read failure');};window.nativeDeskBrowser.refresh();});
  await expect(page.getByText('Refresh unavailable. Actions held until the local workspace can be checked.')).toBeVisible();
  await expect(body).toHaveValue('Still here when refresh fails');
  await expect(page.getByRole('button',{name:'Save edits',exact:true})).toBeDisabled();
  await assertClean(page,state);
});

test('two saved replies in one thread keep exact independent row identities', async ({page}) => {
  const state = await mount(page);
  await page.evaluate(()=>{
    const fixture = window.nativeDeskBrowser.fixture;
    const snapshot = fixture.snapshot();
    const date = '2026-09-09T12:00:00.000Z';
    const thread: Extract<typeof snapshot.answers[number], {kind:'reply'}>['thread'] = {thread:{accountId:'a',mailboxSubject:'mailbox',provider:'gmail' as const,providerThreadId:'thread',messages:[{id:'message',threadId:'thread',rfcMessageId:null,references:[],from:['person@fixture.invalid'],to:['founder@fixture.invalid'],cc:[],date,subject:'Reply',bodyParts:[{mimeType:'text/plain' as const,text:'Tell me more',truncated:false}]}]},revision:1,contextRevision:'context',signals:[]};
    for (const [id,body] of [['reply-one','First exact saved reply'],['reply-two','Second exact saved reply']] as const) snapshot.answers.push({kind:'reply',accountId:'a',thread,draft:{id,body,accountId:'a',mailboxSubject:'mailbox',threadId:'thread',threadRevision:1,contextRevision:'context',revision:1,recipient:'person@fixture.invalid',sender:'founder@fixture.invalid',subject:'Re: Reply',evidenceIds:['message'],generation:'edited',updatedAt:date},stale:false,capability:'held',reason:'reply_capability_unverified'});
    fixture.setSnapshot(snapshot);
    window.nativeDeskBrowser.refresh();
  });
  const replies = page.getByRole('button',{name:'Reply · Account A',exact:true});
  await expect(replies).toHaveCount(2);
  await replies.nth(0).click();
  await expect(page.getByText('First exact saved reply',{exact:true})).toBeVisible();
  await replies.nth(1).click();
  await expect(page.locator('.native-desk__row[aria-current="true"]')).toHaveCount(1);
  await expect(page.getByText('Second exact saved reply',{exact:true})).toBeVisible();
  await page.evaluate(()=>{const f=window.nativeDeskBrowser.fixture;const s=f.snapshot();s.answers.reverse();f.setSnapshot(s);window.nativeDeskBrowser.refresh();});
  await expect(page.getByText('Second exact saved reply',{exact:true})).toBeVisible();
  await expect(page.locator('.native-desk__row[aria-current="true"]')).toHaveCount(1);
  expect((await methods(page)).every(method=>['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments'].includes(method))).toBe(true);
  await assertClean(page,state);
});

test('failed canonical save prevents approval and ambiguous receipt retries the same identity', async ({page}) => {
  const state = await mount(page);
  await page.evaluate(() => {
    type Mutable<T> = { -readonly [K in keyof T]: T[K] };
    const api: Mutable<typeof window.nativeDeskBrowser.fixture.api.delegation> = window.nativeDeskBrowser.fixture.api.delegation;
    const originalEdit = api.editRequestedFollowup;
    let failSave = true;
    api.editRequestedFollowup = async input => {
      if (failSave) { failSave = false; throw Error('fixture save failure'); }
      return originalEdit(input);
    };
    const originalApprove = api.approveRequestedFollowup;
    let loseReceipt = true;
    api.approveRequestedFollowup = async input => {
      const receipt = await originalApprove(input);
      if (loseReceipt) { loseReceipt = false; throw Error('fixture lost response'); }
      return receipt;
    };
  });
  const email = page.getByRole('button',{name:'Email · Account A',exact:true});
  await email.click();
  await page.getByText('Approval permission',{exact:true}).click();
  await page.getByRole('checkbox').check();
  await page.getByLabel('Approval expiry').fill(new Date(Date.now()+86400000).toISOString().slice(0,16));
  const approve = page.getByRole('button',{name:'Approve email',exact:true});
  await approve.click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await methods(page)).filter(method=>method==='approveRequestedFollowup')).toHaveLength(0);
  await approve.click();
  await expect(page.getByRole('button',{name:'Retry same approval',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await email.click();
  await expect(approve).toBeDisabled();
  await page.getByRole('button',{name:'Retry same approval',exact:true}).click();
  await expect(page.getByText(/Approval: pending preflight/)).toBeVisible();
  const approvalCalls = await page.evaluate(()=>window.nativeDeskBrowser.fixture.calls.filter(call=>call.method==='approveRequestedFollowup'));
  expect(approvalCalls).toHaveLength(2);
  expect(approvalCalls[0].input).toEqual(approvalCalls[1].input);
  await assertClean(page,state);
});

test('paused configuration cancels an offscreen draft autosave without losing text', async ({page}) => {
  const state = await mount(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const emailA = page.getByRole('button',{name:'Email · Account A',exact:true});
  await emailA.click();
  await page.getByRole('textbox',{name:'Email body'}).fill('Retain A without sending it after pause');
  await page.getByRole('button',{name:'Email · Account B',exact:true}).click();
  await page.evaluate(()=>{
    window.nativeDeskBrowser.fixture.setConfiguration({state:'paused',workspaceId:'ws',endpoint:'https://owner.fixture.invalid',configuration:{revision:2,configuration:{version:1,state:'paused',research:null},updatedAt:new Date().toISOString()}});
    window.nativeDeskBrowser.refresh();
  });
  await expect(page.getByRole('button',{name:'Save edits',exact:true})).toBeDisabled();
  await page.clock.runFor(1200);
  expect((await methods(page)).filter(method=>method==='editRequestedFollowup')).toHaveLength(0);
  await emailA.click();
  await expect(page.getByRole('textbox',{name:'Email body'})).toHaveValue('Retain A without sending it after pause');
  await assertClean(page,state);
});

test('an edit made while already paused never revives its timer after active remount', async ({page}) => {
  const state = await mount(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.evaluate(()=>{
    window.nativeDeskBrowser.fixture.setConfiguration({state:'paused',workspaceId:'ws',endpoint:'https://owner.fixture.invalid',configuration:{revision:2,configuration:{version:1,state:'paused',research:null},updatedAt:new Date().toISOString()}});
    window.nativeDeskBrowser.refresh();
  });
  await page.getByRole('button',{name:'Email · Account A',exact:true}).click();
  await expect(page.getByRole('button',{name:'Save edits',exact:true})).toBeDisabled();
  await page.getByRole('textbox',{name:'Email body'}).fill('An edit retained while already paused');
  await page.evaluate(()=>window.nativeDeskBrowser.navigate('accounts'));
  await expect(page.getByRole('heading',{name:'Accounts',level:1,exact:true})).toBeVisible();
  await page.evaluate(()=>{
    window.nativeDeskBrowser.fixture.setConfiguration({state:'active',workspaceId:'ws',endpoint:'https://owner.fixture.invalid',configuration:{revision:3,configuration:{version:1,state:'active',research:null},updatedAt:new Date().toISOString()}});
    window.nativeDeskBrowser.navigate('today');
  });
  await expect(page.getByRole('textbox',{name:'Email body'})).toHaveValue('An edit retained while already paused');
  await expect(page.getByRole('button',{name:'Save edits',exact:true})).toBeEnabled();
  await page.clock.runFor(1200);
  expect((await methods(page)).filter(method=>method==='editRequestedFollowup')).toHaveLength(0);
  await page.getByRole('button',{name:'Save edits',exact:true}).click();
  expect((await methods(page)).filter(method=>method==='editRequestedFollowup')).toHaveLength(1);
  await assertClean(page,state);
});

test('approval continuation does not revive after leaving and reopening the same workspace', async ({page}) => {
  const state = await mount(page);
  await page.evaluate(()=>{
    type Mutable<T> = { -readonly [K in keyof T]: T[K] };
    const api: Mutable<typeof window.nativeDeskBrowser.fixture.api.delegation> = window.nativeDeskBrowser.fixture.api.delegation;
    const original = api.editRequestedFollowup;
    api.editRequestedFollowup = async input => {
      await new Promise<void>(resolve=>document.addEventListener('fixture-release-edit',()=>resolve(),{once:true}));
      return original(input);
    };
  });
  const emailA = page.getByRole('button',{name:'Email · Account A',exact:true});
  await emailA.click();
  await page.getByText('Approval permission',{exact:true}).click();
  await page.getByRole('checkbox').check();
  await page.getByLabel('Approval expiry').fill(new Date(Date.now()+86400000).toISOString().slice(0,16));
  const approve = page.getByRole('button',{name:'Approve email',exact:true});
  await approve.click();
  await expect(approve).toBeDisabled();
  await page.evaluate(()=>window.nativeDeskBrowser.navigate('accounts'));
  await expect(page.getByRole('heading',{name:'Accounts',exact:true,level:1})).toBeVisible();
  await page.evaluate(()=>window.nativeDeskBrowser.navigate('today'));
  await expect(page.getByRole('textbox',{name:'Email body'})).toBeVisible();
  await page.evaluate(()=>document.dispatchEvent(new Event('fixture-release-edit')));
  await expect.poll(async()=>(await methods(page)).filter(method=>method==='editRequestedFollowup').length).toBe(1);
  expect((await methods(page)).filter(method=>method==='approveRequestedFollowup')).toHaveLength(0);
  await expect(approve).toBeEnabled();
  await assertClean(page,state);
});

for (const terminal of ['applied','rejected'] as const) {
  test(`pending manual outcome can explicitly reconcile to ${terminal} with identical command`, async ({page}) => {
    const state = await mount(page);
    await page.evaluate(terminal=>{
      type Mutable<T> = { -readonly [K in keyof T]: T[K] };
      const api: Mutable<typeof window.nativeDeskBrowser.fixture.api.linkedin> = window.nativeDeskBrowser.fixture.api.linkedin;
      const original = api.reportOutcome;
      let calls = 0;
      api.reportOutcome = async input => {
        const result = await original(input);
        calls++;
        return calls===1 ? result : {...result,receipt:{...result.receipt,status:terminal,reason:terminal==='rejected'?'Fixture terminal rejection':null}};
      };
    },terminal);
    await page.getByRole('button',{name:'Manual LinkedIn · Account A',exact:true}).click();
    await page.getByRole('button',{name:'Begin manual step',exact:true}).click();
    await page.getByRole('combobox',{name:'Manual outcome'}).selectOption('not_sent');
    await page.getByRole('button',{name:'Record outcome',exact:true}).click();
    const retry = page.getByRole('button',{name:/Retry.*outcome/i});
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.getByText(new RegExp(`receipt: ${terminal}`))).toBeVisible();
    const reports = await page.evaluate(()=>window.nativeDeskBrowser.fixture.calls.filter(call=>call.method==='linkedin.reportOutcome'));
    expect(reports).toHaveLength(2);
    expect(reports[0].input).toEqual(reports[1].input);
    await assertClean(page,state);
  });
}

test('accepting a newer saved email immediately permits explicit preflight and save', async ({page}) => {
  const state = await mount(page);
  await page.getByRole('button',{name:'Email · Account A',exact:true}).click();
  await page.evaluate(()=>{
    const fixture = window.nativeDeskBrowser.fixture;
    const snapshot = fixture.snapshot();
    const item = snapshot.answers.find(answer=>answer.kind==='requested_followup'&&answer.accountId==='a');
    if (!item || item.kind!=='requested_followup') throw Error('Missing fixture email');
    item.draft = {...item.draft,revision:2,body:'Newer saved email from owner'};
    fixture.setSnapshot(snapshot);
    window.nativeDeskBrowser.refresh();
  });
  await page.getByRole('button',{name:'Use saved version and discard displayed edits',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Email body'})).toHaveValue('Newer saved email from owner');
  await page.getByRole('button',{name:'Owner preflight',exact:true}).click();
  await expect.poll(async()=>(await methods(page)).filter(method=>method==='getRequestedFollowup').length).toBe(1);
  await page.getByRole('textbox',{name:'Email body'}).fill('Explicit edit after accepting the saved version');
  await page.getByRole('button',{name:'Save edits',exact:true}).click();
  await expect.poll(async()=>(await methods(page)).filter(method=>method==='editRequestedFollowup').length).toBe(1);
  const saves = await page.evaluate(()=>window.nativeDeskBrowser.fixture.calls.filter(call=>call.method==='editRequestedFollowup'));
  expect(saves[0].input).toMatchObject({expectedRevision:2,body:'Explicit edit after accepting the saved version'});
  expect((await methods(page)).filter(method=>method==='approveRequestedFollowup')).toHaveLength(0);
  await assertClean(page,state);
});

for (const initial of ['pending','unknown'] as const) {
  for (const terminal of ['applied','rejected'] as const) {
    test(`${initial} historical outcome retries exactly to ${terminal} before adopting a newer LinkedIn draft`, async ({page}) => {
      const state = await mount(page);
      await page.evaluate(({initial,terminal})=>{
        type Mutable<T> = { -readonly [K in keyof T]: T[K] };
        const fixture = window.nativeDeskBrowser.fixture;
        const api: Mutable<typeof fixture.api.linkedin> = fixture.api.linkedin;
        const delegation: Mutable<typeof fixture.api.delegation> = fixture.api.delegation;
        delegation.sync = async () => {
          fixture.calls.push({method:'delegation.sync'});
          // Model the owner having reconciled the outbox. The retained editor
          // still needs an explicit exact receipt retry before it can adopt.
          const canonical = fixture.snapshot();
          for (const owner of canonical.ownerStatus) { owner.pendingCommands=[]; owner.status='owner_applied'; }
          fixture.setSnapshot(canonical);
          return {applied:1,gaps:0,cursor:'historical-owner-event',ownerFresh:true};
        };
        const original = api.reportOutcome;
        let retained: Awaited<ReturnType<typeof original>> | undefined;
        api.reportOutcome = async input => {
          if (!retained) {
            retained = await original(input);
            if (initial==='unknown') throw Error('Fixture lost historical receipt');
            return retained;
          }
          // Production supports immutable historical action records. This fixture
          // deliberately preserves the old command instead of querying the new draft.
          if (input.draftId!==retained.draftId || input.expectedRevision!==retained.revision || input.commandId!==retained.receipt.commandId) throw Error('Historical identity changed');
          fixture.calls.push({method:'linkedin.reportOutcome',input:structuredClone(input)});
          return {...retained,receipt:{...retained.receipt,status:terminal,reason:terminal==='rejected'?'Fixture terminal rejection':null}};
        };
      },{initial,terminal});
      await page.getByRole('button',{name:'Manual LinkedIn · Account A',exact:true}).click();
      await page.getByRole('button',{name:'Begin manual step',exact:true}).click();
      await page.getByRole('combobox',{name:'Manual outcome'}).selectOption('not_sent');
      await page.getByRole('button',{name:'Record outcome',exact:true}).click();
      const retry = page.getByRole('button',{name:'Retry retained outcome',exact:true});
      await expect(retry).toBeEnabled();
      await page.evaluate(()=>{
        type Mutable<T> = { -readonly [K in keyof T]: T[K] };
        const fixture = window.nativeDeskBrowser.fixture;
        const snapshot = fixture.snapshot();
        const item = snapshot.answers.find(answer=>answer.kind==='manual_linkedin');
        if (!item || item.kind!=='manual_linkedin' || !item.recovery.approvalCommandId) throw Error('Missing started fixture draft');
        const old = structuredClone(item.recovery);
        old.attempts = [{commandId:item.recovery.approvalCommandId,receipt:{commandId:item.recovery.approvalCommandId,status:'applied',authorityGeneration:1,aggregateVersion:2,reason:null}}];
        const api: Mutable<typeof fixture.api.linkedin> = fixture.api.linkedin;
        api.recover = async input => {
          if (input.draftId!==old.draftId || input.expectedRevision!==old.revision) throw Error('Wrong historical recovery');
          fixture.calls.push({method:'linkedin.recover',input:structuredClone(input)});
          return structuredClone(old);
        };
        item.draft = {...item.draft,revision:item.draft.revision+1,body:'Newer saved LinkedIn note',state:'draft'};
        item.recovery = {...item.recovery,revision:item.draft.revision,approvalCommandId:null,attempts:[],handoffId:null,started:false};
        fixture.setSnapshot(snapshot);
        window.nativeDeskBrowser.refresh();
      });
      const adopt = page.getByRole('button',{name:'Use saved LinkedIn version',exact:true});
      await expect(adopt).toBeDisabled();
      await expect(page.getByRole('textbox',{name:'LinkedIn note'})).toHaveValue('Manual note');
      for (const name of ['Begin manual step','Open LinkedIn','Copy note','Save note']) await expect(page.getByRole('button',{name,exact:true})).toBeDisabled();
      await expect(page.getByRole('button',{name:'Recover receipts',exact:true})).toBeDisabled();
      await page.locator('.native-desk__connection > summary').click();
      expect((await methods(page)).filter(method=>method==='delegation.sync')).toHaveLength(0);
      await page.getByRole('button',{name:'Reconcile queued commands',exact:true}).click();
      await page.getByRole('button',{name:'Recover receipts',exact:true}).click();
      expect((await methods(page)).filter(method=>method==='delegation.sync')).toHaveLength(1);
      await expect.poll(async()=>(await methods(page)).filter(method=>method==='linkedin.recover').length).toBe(1);
      await expect(adopt).toBeDisabled();
      await expect(retry).toBeEnabled();
      await retry.click();
      await expect(page.getByText(new RegExp(`Human outcome receipt: ${terminal}`))).toBeVisible();
      const reports = await page.evaluate(()=>window.nativeDeskBrowser.fixture.calls.filter(call=>call.method==='linkedin.reportOutcome'));
      expect(reports).toHaveLength(2);
      expect(reports[0].input).toEqual(reports[1].input);
      await expect(adopt).toBeEnabled();
      await adopt.click();
      await expect(page.getByRole('textbox',{name:'LinkedIn note'})).toHaveValue('Newer saved LinkedIn note');
      expect((await methods(page)).filter(method=>method==='linkedin.begin')).toHaveLength(1);
      expect((await methods(page)).filter(method=>['linkedin.copy','linkedin.open'].includes(method))).toHaveLength(0);
      await assertClean(page,state);
    });
  }
}

async function localOnly(page: Page, mode: 'legacy' | 'meeting_first' = 'meeting_first') {
  await page.evaluate(mode => {
    const f = window.nativeDeskBrowser.fixture, daily = f.snapshot();
    const account = structuredClone(daily.accounts[0]);
    account.account = { ...account.account, id: 'local-account', name: 'Local Residential PM' };
    account.routes = [];
    f.setLocalSnapshot({scope: 'local_database', generatedAt: daily.freshness.generatedAt,
      workflowMode: mode, transitionReceipt: null, accounts: {state: 'available', snapshots: [account]}});
    f.setCommitments({scope: 'local_database', generatedAt: daily.freshness.generatedAt, revision: 1, reviewErrorCount: 0,
      items: [{kind: 'callback', item: {id: 'retained-cycle', salesCycleId: 'retained-cycle', personId: 'retained-person',
        personName: 'Retained callback contact', stage: 'contacted', lane: 'due_cadence', contextLabel: 'Existing relationship',
        priorityContext: null, action: {id: 'retained-action', type: 'follow_up', channel: 'call', label: 'Call back', dueAt: '2026-09-09T11:00:00.000Z'},
        reason: 'callback_promised_today', activeTriggers: [], verifyFirst: false, pinned: false, consentRequirement: null, cloudScores: null}}]});
    f.setSnapshot({...daily, workspaceId: null, workflowMode: mode, accounts: [], calls: {accountIds: [], workloadConflict: false},
      answers: [], meetings: [], campaigns: [], ownerStatus: [], transport: [], issues: [{code: 'scope_unknown', count: 1}]});
    f.setConfiguration({state: 'unconfigured', workspaceId: null, endpoint: null, configuration: null});
    window.nativeDeskBrowser.refresh();
  }, mode);
}

test('unpaired local records remain selectable without worker authority or automatic contact commands', async ({page}, testInfo) => {
  const state = await mount(page);
  await localOnly(page);
  const row = page.getByRole('button', {name: /Retained callback contact/});
  await row.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'Open contact workspace', exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.nativeDeskBrowser.opened)).toEqual([]);
  for (const width of [1440, 1050]) {
    await page.setViewportSize({width, height: width === 1440 ? 900 : 700});
    const positions = await page.locator('.native-desk__lane h2').evaluateAll(headings => headings.map(el => el.getBoundingClientRect().bottom));
    expect(positions).toHaveLength(3);
    for (const y of positions) expect(y).toBeLessThan(width === 1440 ? 900 : 700);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({path: testInfo.outputPath(`local-commitments-${width}.png`), animations: 'disabled'});
  }
  await page.getByRole('button', {name: 'Open contact workspace', exact: true}).click();
  expect(await page.evaluate(() => window.nativeDeskBrowser.opened)).toEqual(['retained-person']);
  await page.evaluate(() => window.nativeDeskBrowser.navigate('accounts'));
  await expect(page.getByText('Local account library', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: /Local Residential PM/}).click();
  await expect(page.getByRole('heading', {name: 'Local Residential PM', exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.nativeDeskBrowser.fixture.snapshot().accounts)).toEqual([]);
  expect((await methods(page)).filter(method => !['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments'].includes(method))).toEqual([]);
  const audit = await new AxeBuilder({page}).analyze();
  expect(audit.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([]);
  await assertClean(page, state);
});

test('lost local transition response recovers the committed receipt without a second transition on reopen', async ({page}) => {
  const state = await mount(page);
  await localOnly(page, 'legacy');
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture, apply = f.api.localWorkspace.transition;
    Object.assign(f.api.localWorkspace, {transition: async (input: Parameters<typeof apply>[0]) => {await apply(input); throw Error('Fixture response lost after commit');}});
    window.nativeDeskBrowser.navigate('settings');
  });
  await expect(page.getByRole('button', {name: 'Switch to Native Desk', exact: true})).toBeDisabled();
  await page.getByRole('checkbox', {name: /one-way local change/i}).check();
  await page.getByRole('button', {name: 'Switch to Native Desk', exact: true}).click();
  await expect(page.getByText(/Transition result is unknown/)).toBeVisible();
  await page.getByRole('button', {name: 'Check status', exact: true}).click();
  await expect(page.getByText('Native Desk is active.', {exact: true})).toBeVisible();
  const receipt = await page.evaluate(async () => (await window.nativeDeskBrowser.fixture.api.localWorkspace.get()).transitionReceipt);
  expect(receipt).not.toBeNull();
  await page.evaluate(() => window.nativeDeskBrowser.navigate('today'));
  await expect(page.getByRole('button', {name: /Retained callback contact/})).toBeVisible();
  await page.evaluate(() => window.nativeDeskBrowser.navigate('settings'));
  await expect(page.getByText('Native Desk is active.', {exact: true})).toBeVisible();
  expect((await methods(page)).filter(method => method === 'localWorkspace.transition')).toHaveLength(1);
  expect(await page.evaluate(async () => (await window.nativeDeskBrowser.fixture.api.localWorkspace.get()).transitionReceipt)).toEqual(receipt);
  await assertClean(page, state);
});

test('uncommitted local transition retries the exact identity only after an explicit founder action', async ({page}) => {
  const state = await mount(page);
  await localOnly(page, 'legacy');
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture, apply = f.api.localWorkspace.transition;
    let first = true;
    Object.assign(f.api.localWorkspace, {transition: async (input: Parameters<typeof apply>[0]) => {
      if (first) {first = false; f.calls.push({method: 'localWorkspace.transition', input: structuredClone(input)}); throw Error('Fixture request did not commit');}
      return apply(input);
    }});
    window.nativeDeskBrowser.navigate('settings');
  });
  await page.getByRole('checkbox', {name: /one-way local change/i}).check();
  await page.getByRole('button', {name: 'Switch to Native Desk', exact: true}).click();
  await expect(page.getByText(/Transition result is unknown/)).toBeVisible();
  await page.getByRole('button', {name: 'Check status', exact: true}).click();
  const retry = page.getByRole('button', {name: 'Retry same transition', exact: true});
  await expect(retry).toBeEnabled();
  expect((await methods(page)).filter(method => method === 'localWorkspace.transition')).toHaveLength(1);
  await retry.click();
  await expect(page.getByText('Native Desk is active.', {exact: true})).toBeVisible();
  const commands = await page.evaluate(() => window.nativeDeskBrowser.fixture.calls.filter(call => call.method === 'localWorkspace.transition').map(call => call.input));
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  await assertClean(page, state);
});
