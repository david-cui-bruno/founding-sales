import { test, expect, type Page } from 'playwright/test';
import { build } from 'esbuild';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type {} from '../fixtures/nativeDeskBrowser';
import { createCallCampaignDraft, createLinkedInCampaignDraft } from '../../src/shared/contracts/callCampaignDraft';
import { accountFingerprint } from '../../src/main/domain/accounts/accountEvidence';

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
// Exact copy for an enrollment dropdown with no eligible company route. It names the parallel lanes' exact labels
// ("Review phone route" on Accounts, "Send updated saved record to worker" on Campaigns) and promises no call or message.
const noPhoneRouteCopy = 'No published business phone route is saved for this company on the worker\'s copy of its record. On Accounts, open the company and use "Review phone route" to confirm the number from a saved source, then on Campaigns use "Send updated saved record to worker". Enrollment stays unavailable until then.';
const noLinkedInRouteCopy = 'No published business LinkedIn route is saved for this company on the worker\'s copy of its record. There is no LinkedIn review step yet. Import a company LinkedIn profile route on Accounts, then on Campaigns use "Send updated saved record to worker". Enrollment stays unavailable until then.';
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
        expect(geometry.headings).toHaveLength(4);
        await expect(page.locator('.native-desk__lane h2 .native-desk__lane-label')).toHaveText(['Local commitments', 'Calls', 'Saved draft continuations', 'Upcoming meetings']);
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

test('saved manual-call template has separate accessible review and route controls without automatic commands', async ({page}, testInfo) => {
  const state = await mount(page);
  const version = createCallCampaignDraft({campaignId:'browser-campaign',versionId:'browser-version',stepId:'browser-step',accountId:'a',offer:'Discuss a simpler maintenance follow-up workflow.'});
  // Explicit saved projections only. The real owner-command path is covered by
  // callCampaignDraftWorkflow, not a second simulated browser worker.
  await page.evaluate(({version,snapshotHash}) => {
    const f = window.nativeDeskBrowser.fixture;
    const snapshot = f.snapshot();
    snapshot.campaigns = [{version,snapshotHash,caps:[],enrollments:[]}];
    // Walkthrough E: the worker's copy of the company record has no published business phone yet.
    snapshot.accounts[0].routes = [];
    f.setSnapshot(snapshot);
    window.nativeDeskBrowser.navigate('campaigns');
  }, {version,snapshotHash:accountFingerprint(version)});
  // The saved list names the company and channel with a plain state; the saved UUID stays in the review detail.
  const row = page.locator('[data-row-key="campaign:browser-version"]');
  await expect(row.locator('strong')).toHaveText('Account A · Call campaign');
  await expect(row.locator('span')).toHaveText('Version 1 · Draft');
  await row.click();
  const form = page.getByRole('region',{name:'Call campaign enrollment',exact:true});
  const approve = form.getByRole('button',{name:'Approve call campaign',exact:true});
  await expect(approve).toBeDisabled();
  await form.getByRole('checkbox',{name:'I reviewed this company, offer, call step and lifetime limits',exact:true}).check();
  await expect(approve).toBeEnabled();
  await expect(form.getByRole('combobox')).toHaveCount(0);
  expect(await methods(page)).not.toContain('delegation.submit');
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture;
    const snapshot = f.snapshot();
    snapshot.campaigns[0].version.approvedAt = '2026-09-09T12:00:00.000Z';
    snapshot.ownerStatus[0].executionVersion!++;
    f.setSnapshot(snapshot);
    window.nativeDeskBrowser.refresh();
  });
  await expect(page.getByRole('heading',{name:'Reviewed call campaign',exact:true})).toBeVisible();
  await expect(row.locator('span')).toHaveText('Version 1 · Approved');
  const phone = form.getByRole('combobox',{name:'Business phone route',exact:true});
  const enroll = form.getByRole('button',{name:'Enroll company for manual call',exact:true});
  // An empty dropdown says why and what to do next; the select still renders and enrollment stays unavailable.
  const noRoute = form.getByText(noPhoneRouteCopy,{exact:true});
  await expect(phone).toHaveValue('');
  expect(await phone.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['']);
  await expect(noRoute).toBeVisible();
  await expect(noRoute).toHaveAttribute('role','status');
  await expect(enroll).toBeDisabled();
  for (const width of [1440,1050]) {
    await page.setViewportSize({width,height:700});
    for (const theme of ['light','dark'] as const) {
      await page.evaluate(theme => window.nativeDeskBrowser.preferences(theme,'compact'),theme);
      const detail = page.locator('.native-desk__detail');
      const overflow = await detail.evaluate(el => ({overflow:getComputedStyle(el).overflowY,scrollHeight:el.scrollHeight,height:el.clientHeight}));
      expect(overflow.overflow,'campaign review must remain naturally scrollable').not.toBe('hidden');
      if (overflow.scrollHeight > overflow.height) {
        await detail.hover({position:{x:20,y:80}});
        await page.mouse.wheel(0,-2000);
        await expect.poll(() => detail.evaluate(el => el.scrollTop)).toBe(0);
        await page.mouse.wheel(0,2000);
        await expect.poll(() => detail.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
      }
      await expect(phone).toBeVisible();
      const geometry = await phone.evaluate(el => {
        const style = getComputedStyle(el);
        return {content:el.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),text:parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2};
      });
      expect(geometry.content,'selected phone must not be vertically clipped').toBeGreaterThanOrEqual(geometry.text);
      await phone.focus();
      await expect(phone).toBeFocused();
      await expect(noRoute).toBeVisible();
      await expect(row.locator('strong')).toHaveText('Account A · Call campaign');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const axe = await new AxeBuilder({page}).analyze();
      expect(axe.violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
      await page.screenshot({path:testInfo.outputPath(`campaign-enrollment-${width}-${theme}.png`),fullPage:true});
    }
  }
  // The number reaches the worker's copy of the record: the explanation leaves and the same controls take the route.
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture;
    const snapshot = f.snapshot();
    snapshot.accounts[0].routes = [{id:'browser-phone',accountId:'a',personId:null,version:1,channel:'phone',value:'+1 212 555 0100',purpose:'business',verification:'published',evidenceIds:['fixture-source']}];
    f.setSnapshot(snapshot);
    window.nativeDeskBrowser.refresh();
  });
  await expect(noRoute).toHaveCount(0);
  await expect(phone).toHaveValue('');
  await expect(enroll).toBeDisabled();
  await phone.selectOption('browser-phone');
  await expect(enroll).toBeDisabled();
  await form.getByRole('checkbox',{name:'I want this company added to the manual call queue',exact:true}).check();
  await expect(enroll).toBeEnabled();
  await expect(form.getByText('Enrollment adds a due manual-call item. It does not dial, send messages, or grant contact permission.')).toBeVisible();
  expect(await methods(page)).not.toContain('delegation.submit');
  await assertClean(page,state);
});

test('saved manual-LinkedIn template offers a channel choice, LinkedIn review and company-level route controls without automatic commands', async ({page}, testInfo) => {
  const state = await mount(page);
  const version = createLinkedInCampaignDraft({campaignId:'browser-li-campaign',versionId:'browser-li-version',stepId:'browser-li-step',accountId:'a',offer:'Discuss a simpler maintenance follow-up workflow.'});
  // Explicit saved projections only. The real owner-command path is covered by
  // linkedInCampaignLaunchWorkflow, not a second simulated browser worker.
  await page.evaluate(({version,snapshotHash}) => {
    const f = window.nativeDeskBrowser.fixture;
    const snapshot = f.snapshot();
    snapshot.campaigns = [{version,snapshotHash,caps:[],enrollments:[]}];
    snapshot.accounts[0].routes = [
      {id:'browser-phone',accountId:'a',personId:null,version:1,channel:'phone',value:'+1 212 555 0100',purpose:'business',verification:'published',evidenceIds:['fixture-source']},
      {id:'browser-li-company',accountId:'a',personId:null,version:1,channel:'linkedin',value:'https://www.linkedin.com/in/fictional-company',purpose:'business',verification:'published',evidenceIds:['fixture-source']},
      {id:'browser-li-person',accountId:'a',personId:'person-a',version:1,channel:'linkedin',value:'https://www.linkedin.com/in/fictional-person',purpose:'business',verification:'published',evidenceIds:['fixture-source']},
      {id:'browser-li-page',accountId:'a',personId:null,version:1,channel:'linkedin',value:'https://www.linkedin.com/company/fictional-company',purpose:'business',verification:'published',evidenceIds:['fixture-source']},
    ];
    f.setSnapshot(snapshot);
    window.nativeDeskBrowser.navigate('campaigns');
  }, {version,snapshotHash:accountFingerprint(version)});
  // Channel choice on the draft form: one toggle per exact template shares a single form row.
  const draftForm = page.getByRole('region', {name:'New call campaign',exact:true});
  const channel = draftForm.getByRole('group', {name:'Channel',exact:true});
  const callToggle = channel.getByRole('button', {name:'New call campaign',exact:true});
  const linkedInToggle = channel.getByRole('button', {name:'New LinkedIn campaign',exact:true});
  await callToggle.click();
  await expect(callToggle).toHaveAttribute('aria-expanded','true');
  await expect(draftForm.getByRole('button', {name:'Save call campaign draft',exact:true})).toBeVisible();
  await linkedInToggle.click();
  await expect(callToggle).toHaveAttribute('aria-expanded','false');
  await expect(linkedInToggle).toHaveAttribute('aria-expanded','true');
  await expect(draftForm.getByRole('button', {name:'Save LinkedIn campaign draft',exact:true})).toBeDisabled();
  await expect(draftForm.getByText('Saves an unapproved LinkedIn campaign draft. This does not enroll accounts, prepare or send a note, or start outreach.')).toBeVisible();
  const liRow = page.locator('[data-row-key="campaign:browser-li-version"]');
  await expect(liRow.locator('strong')).toHaveText('Account A · LinkedIn campaign');
  await expect(liRow.locator('span')).toHaveText('Version 1 · Draft');
  await liRow.click();
  await expect(page.getByRole('heading',{name:'LinkedIn campaign draft',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Call campaign enrollment',exact:true})).toHaveCount(0);
  const form = page.getByRole('region',{name:'LinkedIn campaign enrollment',exact:true});
  const approve = form.getByRole('button',{name:'Approve LinkedIn campaign',exact:true});
  await expect(approve).toBeDisabled();
  await form.getByRole('checkbox',{name:'I reviewed this company, offer, LinkedIn step and lifetime limits',exact:true}).check();
  await expect(approve).toBeEnabled();
  await expect(form.getByRole('combobox')).toHaveCount(0);
  expect(await methods(page)).not.toContain('delegation.submit');
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture;
    const snapshot = f.snapshot();
    snapshot.campaigns[0].version.approvedAt = '2026-09-09T12:00:00.000Z';
    snapshot.ownerStatus[0].executionVersion!++;
    f.setSnapshot(snapshot);
    window.nativeDeskBrowser.refresh();
  });
  await expect(page.getByRole('heading',{name:'Reviewed LinkedIn campaign',exact:true})).toBeVisible();
  await expect(liRow.locator('span')).toHaveText('Version 1 · Approved');
  const route = form.getByRole('combobox',{name:'Business LinkedIn route',exact:true});
  const enroll = form.getByRole('button',{name:'Enroll company for manual LinkedIn note',exact:true});
  await expect(form.getByRole('combobox',{name:'Business phone route',exact:true})).toHaveCount(0);
  await expect(route).toHaveValue('');
  expect(await route.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(['','browser-li-company']);
  // A saved company LinkedIn route is offered, so the empty-dropdown explanation stays away.
  await expect(form.getByText(noLinkedInRouteCopy,{exact:true})).toHaveCount(0);
  await expect(enroll).toBeDisabled();
  await route.selectOption('browser-li-company');
  await expect(enroll).toBeDisabled();
  await form.getByRole('checkbox',{name:'I want this company added to the manual LinkedIn queue',exact:true}).check();
  await expect(enroll).toBeEnabled();
  await expect(form.getByText('Enrollment adds a due manual LinkedIn preparation item. It does not send a message, connect, or grant contact permission.')).toBeVisible();
  await expect(page.getByText('No active LinkedIn enrollment is available. Creating or enrolling a LinkedIn campaign is not available here.')).toBeVisible();
  for (const width of [1440,1050]) {
    await page.setViewportSize({width,height:700});
    for (const theme of ['light','dark'] as const) {
      await page.evaluate(theme => window.nativeDeskBrowser.preferences(theme,'compact'),theme);
      const detail = page.locator('.native-desk__detail');
      expect((await detail.evaluate(el => getComputedStyle(el).overflowY)),'campaign review must remain naturally scrollable').not.toBe('hidden');
      await expect(route).toBeVisible();
      const geometry = await route.evaluate(el => {
        const style = getComputedStyle(el);
        return {content:el.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom),text:parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.2};
      });
      expect(geometry.content,'selected LinkedIn route must not be vertically clipped').toBeGreaterThanOrEqual(geometry.text);
      await route.focus();
      await expect(route).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const axe = await new AxeBuilder({page}).analyze();
      expect(axe.violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
      await page.screenshot({path:testInfo.outputPath(`linkedin-campaign-enrollment-${width}-${theme}.png`),fullPage:true});
    }
  }
  expect(await methods(page)).not.toContain('delegation.submit');
  expect((await methods(page)).some(method => method.startsWith('linkedin.'))).toBe(false);
  await assertClean(page,state);
});

test('territory call policy panel shows the standing sequence above the manual drafts and holds without the bridge, with no automatic call', async ({page}) => {
  const state = await mount(page);
  await page.evaluate(() => window.nativeDeskBrowser.navigate('campaigns'));
  const panel = page.getByRole('region', {name:'Territory call policy',exact:true});
  await expect(panel.getByRole('heading', {name:'Territory call policy',exact:true})).toBeVisible();
  // The standing definition folds away by default and opens on request.
  await expect(panel.getByRole('listitem').first()).toBeHidden();
  await panel.getByText('Sequence, caps, objective and audience', {exact:true}).click();
  await expect(panel.getByRole('listitem')).toHaveText(['Day 0 · Call', 'Day 3 · Call', 'Day 7 · Email T4 · held: mailbox not connected', 'Day 12 · Call', 'Day 21 · Email T5 · held: mailbox not connected']);
  await expect(panel.getByText('Audience: every firm the Places discovery creates in this workspace.', {exact:true})).toBeVisible();
  // The isolated fixture bridge carries no territory policy capability: the panel says so and offers no action.
  await expect(panel.getByText('Territory call policy is not available on this bridge.', {exact:true})).toBeVisible();
  await expect(panel.getByRole('button')).toHaveCount(0);
  await expect(panel.getByRole('checkbox')).toHaveCount(0);
  await expect(panel.getByRole('button', {name:'Approve territory call policy',exact:true})).toHaveCount(0);
  // The panel precedes Lenox's manual one-company drafts, which stay reachable and unchanged.
  const regions = await page.getByRole('region').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  expect(regions.indexOf('Territory call policy')).toBeLessThan(regions.indexOf('New call campaign'));
  await page.getByRole('button', {name:'New call campaign',exact:true}).click();
  await expect(page.getByRole('region', {name:'New call campaign',exact:true}).getByRole('button', {name:'Save call campaign draft',exact:true})).toBeVisible();
  expect((await methods(page)).every(method => ['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments'].includes(method))).toBe(true);
  await assertClean(page, state);
});
test('new call campaign form retains explicit company and offer across routes without queuing work', async ({page}, testInfo) => {
  const state = await mount(page);
  await page.evaluate(() => window.nativeDeskBrowser.navigate('campaigns'));
  await page.getByRole('button', {name:'New call campaign',exact:true}).click();
  const form = page.getByRole('region', {name:'New call campaign',exact:true});
  const company = form.getByRole('combobox', {name:'Company',exact:true});
  const offer = form.getByRole('textbox', {name:'Meeting offer',exact:true});
  await company.selectOption('a');
  await offer.fill('Discuss a simpler maintenance follow-up workflow.');
  await expect(form.getByRole('button', {name:'Save call campaign draft'})).toBeEnabled();
  await expect(form.getByText('Saves an unapproved campaign draft. This does not enroll accounts, activate a campaign, or start outreach.')).toBeVisible();
  await page.evaluate(() => window.nativeDeskBrowser.navigate('accounts'));
  await expect(form).toHaveCount(0);
  await page.evaluate(() => window.nativeDeskBrowser.navigate('campaigns'));
  await expect(company).toHaveValue('a');
  await expect(offer).toHaveValue('Discuss a simpler maintenance follow-up workflow.');
  for (const width of [1440,1050]) {
    await page.setViewportSize({width,height:700});
    for (const theme of ['light','dark'] as const) {
      await page.evaluate(theme => window.nativeDeskBrowser.preferences(theme,'compact'),theme);
      await expect(company).toBeVisible();
      await expect(offer).toBeVisible();
      const selectGeometry = await company.evaluate(el => {
        const style = getComputedStyle(el);
        return { content: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), text: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 };
      });
      expect(selectGeometry.content, 'selected company text must fit without vertical clipping').toBeGreaterThanOrEqual(selectGeometry.text);
      await offer.focus();
      await offer.evaluate(el => { const field = el as HTMLTextAreaElement; field.setSelectionRange(field.value.length, field.value.length); });
      await page.keyboard.type(' k');
      await expect(offer).toBeFocused();
      await expect(offer).toHaveValue(/ k$/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const axe = await new AxeBuilder({page}).analyze();
      expect(axe.violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
      await page.screenshot({path:testInfo.outputPath(`campaign-draft-${width}-${theme}.png`),fullPage:true});
    }
  }
  // One control row less room than the 700px geometry. The split body keeps the queue and the
  // welcome text usable; the desk scrolls instead of collapsing the body to a sliver.
  await page.setViewportSize({width:1050,height:620});
  await page.evaluate(() => window.nativeDeskBrowser.preferences('light','compact'));
  await expect(company).toBeVisible();
  const squeezed = await page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const detail = box('.native-desk__detail'), heading = box('.native-desk__welcome h2'), text = box('.native-desk__welcome p');
    return { queue: document.querySelector('.native-desk__queue')!.clientHeight, inside: heading.top >= detail.top && text.bottom <= detail.bottom };
  });
  expect(squeezed.inside, 'welcome text must stay inside its pane at 620px').toBe(true);
  expect(squeezed.queue, 'campaign queue must keep a usable height at 620px').toBeGreaterThanOrEqual(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const squeezedAxe = await new AxeBuilder({page}).analyze();
  expect(squeezedAxe.violations.filter(item=>item.impact==='serious'||item.impact==='critical')).toEqual([]);
  expect((await methods(page)).every(method => ['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments'].includes(method))).toBe(true);
  await assertClean(page,state);
});

test('explicit exact email approval stays separate from sending', async ({page}) => {
  const state = await mount(page);
  await page.getByRole('button',{name:'Email · Account A',exact:true}).click();
  await expect(page.getByRole('checkbox')).toBeVisible();
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
  await expect(page.getByRole('checkbox')).toBeVisible();
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
  // The call card also says "Portfolio: 12 managed buildings"; the evidence block's own line is the exact text.
  await expect(page.getByText('12 managed buildings', {exact: true})).toBeVisible();
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
  await expect(page.getByRole('region', { name: 'Saved draft continuations 3', exact: true }).locator('[data-row-key]')).toHaveCount(3);
  const replies = page.getByRole('region', { name: 'Saved reply history 2', exact: true }).getByRole('button',{name:'Reply · Account A',exact:true});
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
  await expect(page.getByRole('checkbox')).toBeVisible();
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
  await expect(page.getByRole('checkbox')).toBeVisible();
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
  await page.locator('.native-desk__approval-checks > summary').click();
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
  // Pure presentation: the retained detail offers no contact, call or send control.
  const retainedDetail = page.getByRole('region', {name: 'Retained work detail', exact: true});
  await expect(retainedDetail).toContainText('Stored local work. Nothing here calls, sends or books.');
  await expect(retainedDetail.getByRole('button')).toHaveCount(0);
  for (const width of [1440, 1050]) {
    await page.setViewportSize({width, height: width === 1440 ? 900 : 700});
    const positions = await page.locator('.native-desk__lane h2').evaluateAll(headings => headings.map(el => el.getBoundingClientRect().bottom));
    expect(positions).toHaveLength(4);
    await expect(page.locator('.native-desk__lane h2 .native-desk__lane-label')).toHaveText(['Local commitments', 'Calls', 'Saved draft continuations', 'Upcoming meetings']);
    for (const y of positions) expect(y).toBeLessThan(width === 1440 ? 900 : 700);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const heading = await page.locator('.native-desk__lane h2').first().evaluate(el => {
      const label = el.querySelector<HTMLElement>('.native-desk__lane-label')!;
      const count = el.querySelector<HTMLElement>('.native-desk__count')!;
      const range = document.createRange(); range.selectNodeContents(label);
      return {lines: range.getClientRects().length, labelWidth: label.getBoundingClientRect().width,
        labelScroll: label.scrollWidth, countRight: count.getBoundingClientRect().right, right: el.getBoundingClientRect().right};
    });
    expect(heading.lines).toBe(1);
    expect(heading.labelWidth + 1).toBeGreaterThanOrEqual(heading.labelScroll);
    expect(heading.countRight).toBeLessThanOrEqual(heading.right + 1);
    await expect(page.locator('.native-desk__detail-bar')).toContainText('Existing commitments and relationships');
    await page.screenshot({path: testInfo.outputPath(`local-commitments-${width}.png`), animations: 'disabled'});
  }
  await page.evaluate(() => window.nativeDeskBrowser.navigate('accounts'));
  await expect(page.getByText('Local account library', {exact: true})).toBeVisible();
  expect((await methods(page)).filter(method => method === 'localWorkspace.getCompany')).toEqual([]);
  await page.getByRole('button', {name: /Local Residential PM/}).click();
  await expect(page.getByRole('heading', {name: 'Local Residential PM', exact: true})).toBeVisible();
  await expect(page.getByText('Company evidence unavailable. Reopen this detail to check again.', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.nativeDeskBrowser.fixture.calls.filter(call => call.method === 'localWorkspace.getCompany'))).toEqual([{method: 'localWorkspace.getCompany', input: {accountId: 'local-account'}}]);
  expect(await page.evaluate(() => window.nativeDeskBrowser.fixture.snapshot().accounts)).toEqual([]);
  expect((await methods(page)).filter(method => !['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments','localWorkspace.getCompany'].includes(method))).toEqual([]);
  const audit = await new AxeBuilder({page}).analyze();
  expect(audit.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([]);
  await assertClean(page, state);
});

test('selected local account survives recovery of an initially unavailable daily workspace', async ({page}) => {
  const state = await mount(page);
  await localOnly(page);
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture;
    Object.assign(f.api.daily, {get: async () => { throw Error('Fixture daily read unavailable'); }});
    window.nativeDeskBrowser.navigate('accounts');
  });
  await expect(page.getByText(/Daily workspace unavailable/)).toBeVisible();
  expect((await methods(page)).filter(method => method === 'localWorkspace.getCompany')).toEqual([]);
  await page.getByRole('button', {name: /Local account · Local Residential PM/}).click();
  await expect(page.getByRole('heading', {name: 'Local Residential PM', exact: true})).toBeVisible();
  await expect(page.getByText('Company evidence unavailable. Reopen this detail to check again.', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.nativeDeskBrowser.fixture.calls.filter(call => call.method === 'localWorkspace.getCompany'))).toEqual([{method: 'localWorkspace.getCompany', input: {accountId: 'local-account'}}]);
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture;
    Object.assign(f.api.daily, {get: async () => { f.calls.push({method: 'daily.get'}); return f.snapshot(); }});
  });
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await expect(page.getByText(/Daily workspace unavailable/)).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'Local Residential PM', exact: true})).toBeVisible();
  await expect(page.getByText('Company evidence unavailable. Reopen this detail to check again.', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.nativeDeskBrowser.fixture.calls.filter(call => call.method === 'localWorkspace.getCompany'))).toEqual([
    {method: 'localWorkspace.getCompany', input: {accountId: 'local-account'}},
    {method: 'localWorkspace.getCompany', input: {accountId: 'local-account'}},
  ]);
  expect((await methods(page)).filter(method => !['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments','localWorkspace.getCompany'].includes(method))).toEqual([]);
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

test('approved A presentation matches the unchanged reference in both themes and widths', async ({page, context}, testInfo) => {
  const state = await mount(page);
  const reference = await context.newPage();
  const referenceRequests: string[] = [];
  await reference.route('**/*', route => { referenceRequests.push(route.request().url()); return route.abort(); });
  await reference.setContent(readFileSync(path.resolve('docs/archive/prototypes/2026-09-09-today-studies.html'), 'utf8'));
  await reference.locator('[data-item="nora"]').click();
  await page.getByRole('button', {name: 'Email · Account A', exact: true}).click();
  for (const width of [1440, 1050]) {
    const viewport = {width, height: width === 1440 ? 900 : 700};
    await page.setViewportSize(viewport); await reference.setViewportSize(viewport);
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(theme => window.nativeDeskBrowser.preferences(theme, 'compact'), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
      await reference.evaluate(theme => { document.documentElement.dataset.study = 'native'; document.documentElement.dataset.theme = theme; }, theme);
      const capture = async (target: Page, selectors: string[]) => target.evaluate(selectors => selectors.map(selector => {
        const node = document.querySelector<HTMLElement>(selector)!;
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return {color: style.color, background: style.backgroundColor, family: style.fontFamily, weight: style.fontWeight, spacing: style.letterSpacing, size: parseFloat(style.fontSize), radius: parseFloat(style.borderRadius),
          width: rect.width, height: rect.height, centerY: rect.y + rect.height / 2};
      }), selectors);
      const expected = await capture(reference, ['.wordmark', '.nav-item', '.page-head h1', '.head-status .icon-button', '.queue', '#subject', '#message']);
      const actual = await capture(page, ['.nav-rail__brand-native', '.nav-rail__item', '.native-desk h1', '.native-desk__refresh', '.native-desk__queue', 'input[aria-label="Email subject"]', 'textarea[aria-label="Email body"]']);
      const label = `${width}/${theme}`;
      expect.soft(actual[0].color, `${label} coral wordmark`).toBe(expected[0].color);
      expect.soft(actual[0].family, `${label} wordmark font`).toBe(expected[0].family);
      expect.soft(actual[0].size, `${label} wordmark size`).toBe(expected[0].size);
      expect.soft(actual[0].weight, `${label} wordmark weight`).toBe(expected[0].weight);
      expect.soft(actual[0].spacing, `${label} wordmark tracking`).toBe(expected[0].spacing);
      for (const index of [5, 6]) {
        expect.soft(actual[index].background, `${label} field ${index} native background`).toBe(expected[index].background);
        expect.soft(actual[index].radius, `${label} field ${index} rounded corners`).toBe(expected[index].radius);
        expect.soft(actual[index].size, `${label} field ${index} text size`).toBe(expected[index].size);
      }
      expect.soft(actual[5].height, `${label} padded subject field`).toBe(expected[5].height);
      expect.soft(actual[1].radius, `${label} rounded navigation`).toBe(expected[1].radius);
      expect.soft(Math.abs(actual[1].height - expected[1].height), `${label} padded navigation`).toBeLessThanOrEqual(3);
      expect.soft(actual[2].size, `${label} compact title`).toBe(expected[2].size);
      expect.soft(actual[3].width, `${label} icon refresh width`).toBe(expected[3].width);
      expect.soft(actual[3].height, `${label} icon refresh height`).toBe(expected[3].height);
      expect.soft(Math.abs(actual[4].width - expected[4].width), `${label} queue width`).toBeLessThanOrEqual(2);
      const status = await page.locator('.native-desk__connection > summary').boundingBox();
      expect.soft(Math.abs(status!.y + status!.height / 2 - actual[3].centerY), `${label} horizontal status`).toBeLessThanOrEqual(3);
      expect.soft(await page.getByText('Your next conversations', {exact: true}).count()).toBe(1);
      expect.soft(await page.locator('.native-desk__lane h2 svg').count()).toBe(4);
      expect.soft(await page.locator('.native-desk__lane h2 .native-desk__count').count()).toBe(4);
      await expect.soft(page.locator('.native-desk__lane h2 .native-desk__lane-label')).toHaveText(['Local commitments', 'Calls', 'Saved draft continuations', 'Upcoming meetings']);
      expect.soft(await page.getByRole('button', {name: 'Refresh', exact: true}).innerText()).toBe('');
      await page.screenshot({path: testInfo.outputPath(`restored-A-${width}-${theme}.png`), animations: 'disabled'});
    }
  }
  expect(referenceRequests).toEqual([]);
  await reference.close();
  await assertClean(page, state);
});

test('approved A empty unpaired surfaces stay coherent and truthful without invented work', async ({page}, testInfo) => {
  const state = await mount(page);
  await localOnly(page);
  await page.evaluate(async () => {
    const f = window.nativeDeskBrowser.fixture, local = await f.api.localWorkspace.get(), daily = f.snapshot();
    f.setLocalSnapshot({...local, accounts: {state: 'available', snapshots: []}});
    f.setCommitments({scope: 'local_database', generatedAt: daily.freshness.generatedAt, revision: 2, reviewErrorCount: 0, items: []});
    f.setSnapshot({...daily, freshness: {...daily.freshness, kind: 'incomplete'}});
    window.nativeDeskBrowser.refresh();
  });
  for (const surface of ['today', 'accounts', 'campaigns'] as const) {
    await page.evaluate(surface => window.nativeDeskBrowser.navigate(surface), surface);
    await expect(page.locator('[data-row-key]')).toHaveCount(0);
    for (const width of [1440, 1050]) {
      await page.setViewportSize({width, height: width === 1440 ? 900 : 700});
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(theme => window.nativeDeskBrowser.preferences(theme, 'compact'), theme);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
        const detail = page.locator('.native-desk__detail');
        expect.soft(await detail.innerText()).not.toMatch(/Select an item/i);
        const card = (await detail.boundingBox())!;
        const footer = (await page.locator('.native-desk__footer').boundingBox())!;
        expect.soft(card.height, `${surface}/${width}/${theme} coherent inset state`).toBeGreaterThan(300);
        expect.soft(card.y + card.height, `${surface}/${width}/${theme} card clears footer`).toBeLessThanOrEqual(footer.y + 1);
        await expect(page.locator('.native-desk__connection > summary')).toContainText(/unavailable|unconfigured|unpaired/i);
        await expect(page.getByText(/remote freshness unknown/i).last()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect.soft((await page.locator('.native-desk__footer').boundingBox())!.y + (await page.locator('.native-desk__footer').boundingBox())!.height, `${surface}/${width}/${theme} footer fits viewport`).toBeLessThanOrEqual(width === 1440 ? 900 : 700);
        const labels = await page.locator('.nav-rail__list:first-of-type .nav-rail__label').evaluateAll(nodes => nodes.map(node => { const range = document.createRange(); range.selectNodeContents(node); return {text: node.textContent, width: node.getBoundingClientRect().width, fullTextWidth: range.getBoundingClientRect().width}; }));
        expect(labels).toHaveLength(3);
        for (const label of labels) expect.soft(label.fullTextWidth, `${width} complete primary label ${label.text}`).toBeLessThanOrEqual(label.width + 0.05);
        if (surface === 'today') {
          const headings = await page.locator('.native-desk__lane h2').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().bottom));
          expect(headings).toHaveLength(4);
          await expect(page.locator('.native-desk__lane h2 .native-desk__lane-label')).toHaveText(['Local commitments', 'Calls', 'Saved draft continuations', 'Upcoming meetings']);
          for (const bottom of headings) expect(bottom).toBeLessThan(width === 1440 ? 900 : 700);
        }
        const axe = await new AxeBuilder({page}).analyze();
        expect(axe.violations.filter(issue => issue.impact === 'serious' || issue.impact === 'critical')).toEqual([]);
        await page.screenshot({path: testInfo.outputPath(`empty-A-${surface}-${width}-${theme}.png`), animations: 'disabled'});
      }
    }
  }
  expect((await methods(page)).filter(method => !['daily.get','delegation.status','localWorkspace.get','localWorkspace.getCommitments'].includes(method))).toEqual([]);
  await assertClean(page, state);
});

test('isolated Native rail keeps its four destinations keyboard reachable in both workflows without substituting other destinations', async ({page}) => {
  const state = await mount(page);
  const rail = page.getByRole('navigation', {name: 'Primary', exact: true});
  const labels = ['Today', 'Accounts', 'Campaigns', 'Settings'];
  const traverseRail = async () => {
    // Four plain links: no disclosure, badge or secondary group remains after the person workspaces were removed.
    await expect(rail.getByRole('link')).toHaveCount(4);
    await expect(rail.getByRole('button')).toHaveCount(0);
    for (const label of labels) await expect(rail.getByRole('link', {name: label, exact: true})).toBeVisible();
    for (const label of ['Leads', 'Pipeline', 'Conversations', 'Learnings', 'Friday', 'Inbox']) await expect(rail.getByRole('link', {name: label, exact: true, includeHidden: true})).toHaveCount(0);
    await rail.getByRole('link', {name: 'Today', exact: true}).focus();
    for (const label of labels.slice(1)) {
      await page.keyboard.press('Tab');
      await expect(rail.getByRole('link', {name: label, exact: true})).toBeFocused();
    }
  };
  await traverseRail();
  // Actual destination/render/read assertions live in applicationPresentation.spec.
  await localOnly(page, 'legacy');
  await expect(page.getByText('Legacy workflow is active. Local records remain available. Switch to Native Desk in Settings to change the daily workspace. Worker actions are held.', {exact: true})).toBeVisible();
  await expect(page.getByTestId('native-desk')).toHaveCount(0);
  await traverseRail();
  await assertClean(page, state);
});

test('approved A scrollable lanes keep every queued row keyboard reachable without commands', async ({page}) => {
  const state = await mount(page);
  await page.setViewportSize({width: 1050, height: 700});
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture, snapshot = f.snapshot();
    const accounts = Array.from({length: 20}, (_, index) => ({...snapshot.accounts[0], account: {...snapshot.accounts[0].account, id: `scroll-${index}`, name: `Scroll account ${index}`}}));
    f.setSnapshot({...snapshot, accounts: [...snapshot.accounts, ...accounts], calls: {...snapshot.calls, accountIds: accounts.map(a => a.account.id)}});
    window.nativeDeskBrowser.refresh();
  });
  const rows = page.locator('.native-desk__lane[aria-label="Calls"] [data-row-key]');
  await expect(rows).toHaveCount(20);
  await rows.first().focus();
  for (let index = 1; index < 20; index++) {
    await page.keyboard.press('j');
    await expect(rows.nth(index)).toBeFocused();
  }
  const last = await rows.last().boundingBox(), lane = await page.locator('.native-desk__lane[aria-label="Calls"]').boundingBox();
  expect(last!.y).toBeGreaterThanOrEqual(lane!.y);
  expect(last!.y + last!.height).toBeLessThanOrEqual(lane!.y + lane!.height + 1);
  await page.keyboard.press('Enter');
  await expect(page.locator('.native-desk__detail')).toContainText('Scroll account 19');
  await expect(rows.last()).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('j');
  await expect(page.getByRole('button', {name: 'Email · Account A', exact: true})).toBeFocused();
  const headings = await page.locator('.native-desk__lane h2').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().bottom));
  for (const bottom of headings) expect(bottom).toBeLessThanOrEqual(700);
  expect((await methods(page)).filter(method => !['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments'].includes(method))).toEqual([]);
  await assertClean(page, state);
});


test('the morning call card and the footer line read saved facts only and place no call', async ({page}) => {
  const state = await mount(page);
  await page.evaluate(() => {
    const f = window.nativeDeskBrowser.fixture, snapshot = f.snapshot();
    const hash = 'a'.repeat(64), now = snapshot.freshness.generatedAt;
    const firm = snapshot.accounts[0];
    firm.account.name = 'Fictional Harbor PM'; firm.account.domain = 'harbor.example.invalid';
    firm.claims = [{kind: 'fact', key: 'residential_scope', value: 'Residential and multifamily rentals', evidenceIds: ['site']}];
    firm.routes = [{id: 'listed-phone', accountId: 'a', personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', verification: 'listed', evidenceIds: ['places'], version: 1}];
    firm.portfolio = [{count: 340, measure: 'units', scope: 'managed', evidenceIds: ['site']}];
    snapshot.callSettings = {newCallSlots: null, totalCallCapacity: null}; snapshot.allocation = {newCallSlots: 30, source: 'default'};
    snapshot.transport = [{pairingId: 'pairing', revision: 4, state: 'complete', startedAt: new Date(Date.now() - 150_000).toISOString(), completedAt: new Date(Date.now() - 120_000).toISOString()}];
    f.setSnapshot(snapshot);
    f.setCompanyDetails([{scope: 'local_database', generatedAt: now, snapshot: firm, links: [], sources: [
      {id: 'places', url: 'https://places.googleapis.com/v1/places:searchText', fetchedAt: now, sha256: hash, permitted: true,
        excerpt: JSON.stringify({id: 'place-1', displayName: 'Fictional Harbor PM', formattedAddress: '12 Harbor Way, Newport, RI 02840, USA', nationalPhoneNumber: '(401) 555-0100', websiteUri: 'https://harbor.example.invalid/'})},
      {id: 'site', url: 'https://harbor.example.invalid/about', fetchedAt: now, sha256: hash, permitted: true, excerpt: 'We manage 340 residential and multifamily rental units.'},
    ]}]);
    window.nativeDeskBrowser.refresh();
  });
  // Footer: stored sync record plus the honest unknowns (no research status api in this fixture), and the default allocation named in the details.
  const footer = page.locator('.native-desk__footer');
  await expect(footer.getByRole('status')).toHaveText('Synced 2 min ago · worker last ran unknown · discovery spend unknown');
  await footer.getByText('Queue capacity and operational details', {exact: true}).click();
  await expect(footer).toContainText('New-call slots: 30 (default: 30 new firms a day)');
  await page.getByRole('button', {name: 'Call · Fictional Harbor PM', exact: true}).click();
  const card = page.getByRole('region', {name: 'Call card', exact: true});
  await expect(card.getByRole('heading', {level: 3, name: 'Fictional Harbor PM', exact: true})).toBeVisible();
  await expect(card).toContainText('+14015550100 · listed in a business directory');
  await expect(card).toContainText('Website: https://harbor.example.invalid/');
  await expect(card).toContainText('Location: Newport, RI');
  await expect(card).toContainText('Portfolio: 340 managed units');
  await expect(card).toContainText('Residential: Residential and multifamily rentals');
  await expect(card).toContainText('Source: https://places.googleapis.com/v1/places:searchText');
  await expect(card.locator('button, a, input, select')).toHaveCount(0);
  await expect(page.getByTestId('last-outcome')).toHaveText('Last outcome: unknown until the saved phone history is read');
  // Only local reads happened: the card's company detail read, never a command, sync or handoff.
  expect((await methods(page)).filter(method => !['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments', 'localWorkspace.getCompany'].includes(method))).toEqual([]);
  await assertClean(page, state);
});

test('local company form keeps A geometry and explicit review/create/reuse boundaries', async ({ page }, testInfo) => {
  const state = await mount(page);
  await page.evaluate(async () => {
    const f = window.nativeDeskBrowser.fixture;
    const snapshot = await f.api.daily.get();
    f.setSnapshot({ ...snapshot, workspaceId: null, accounts: [], answers: [], meetings: [], campaigns: [], ownerStatus: [], transport: [], calls: { accountIds: [], workloadConflict: false } });
    const local = await f.api.localWorkspace.get();
    f.setLocalSnapshot({ ...local, accounts: { state: 'available', snapshots: [] } });
    // Explicit synthetic presentation adapter. Real persistence/IPC is covered by
    // accountPreparation.spec.ts against the separately signed application.
    let saved: { id: string; name: string; domain: string | null; version: number } | null = null;
    f.api.localWorkspace.reviewCompany = async input => {
      f.calls.push({ method: 'localWorkspace.reviewCompany', input });
      return { scope: 'local_database', input, complete: true, candidates: saved ? [{ account: saved, signals: ['same_domain'] }] : [] };
    };
    f.api.localWorkspace.createCompany = async input => {
      f.calls.push({ method: 'localWorkspace.createCompany', input });
      saved = { id: 'browser-local-company', name: input.name, domain: input.domain, version: 1 };
      f.setLocalSnapshot({ ...local, accounts: { state: 'available', snapshots: [{ account: saved, claims: [], routes: [], portfolio: [], unknowns: ['Maintenance workflow not recorded'], conflicts: [], fingerprint: 'd'.repeat(64) }] } });
      return { status: 'saved', commandId: input.commandId, account: saved, replayed: false };
    };
  });
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Add company', exact: true }).click();
  await page.getByRole('button', { name: 'Review company', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a company name and an optional hostname such as company.example, without a URL or path.');
  await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeDisabled();
  expect((await methods(page)).filter(name => /localWorkspace\.(reviewCompany|createCompany|getCompanyCreateStatus)/.test(name))).toEqual([]);
  await page.getByRole('textbox', { name: 'Company name', exact: true }).fill('Browser Residential Management');
  await page.getByRole('textbox', { name: 'Company domain (optional)', exact: true }).fill('not a hostname');
  await page.getByRole('button', { name: 'Review company', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a company name and an optional hostname such as company.example, without a URL or path.');
  await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeDisabled();
  expect((await methods(page)).filter(name => /localWorkspace\.(reviewCompany|createCompany|getCompanyCreateStatus)/.test(name))).toEqual([]);
  await page.getByRole('textbox', { name: 'Company domain (optional)', exact: true }).fill('browser.example');
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(theme => window.nativeDeskBrowser.preferences(theme, 'compact'), theme);
    for (const width of [1440, 1050]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 });
      for (const name of ['Company name', 'Company domain (optional)']) {
        const box = await page.getByRole('textbox', { name, exact: true }).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`company-form-${width}-${theme}.png`), animations: 'disabled' });
      const audit = await new AxeBuilder({ page }).analyze();
      expect(audit.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([]);
    }
  }
  expect((await methods(page)).filter(name => /localWorkspace\.(reviewCompany|createCompany|getCompanyCreateStatus)/.test(name))).toEqual([]);
  await page.getByRole('button', { name: 'Review company', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeEnabled();
  expect((await methods(page)).filter(name => name === 'localWorkspace.createCompany')).toEqual([]);
  expect((await methods(page)).filter(method => method === 'localWorkspace.getCompany')).toEqual([]);
  await page.getByRole('button', { name: 'Create company', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Browser Residential Management', exact: true })).toBeVisible();
  await expect(page.getByText('Company evidence unavailable. Reopen this detail to check again.', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.nativeDeskBrowser.fixture.calls.filter(call => call.method === 'localWorkspace.getCompany'))).toEqual([{method: 'localWorkspace.getCompany', input: {accountId: 'browser-local-company'}}]);
  expect((await methods(page)).filter(name => name === 'localWorkspace.createCompany')).toHaveLength(1);
  await page.getByRole('button', { name: 'Add company', exact: true }).click();
  await page.getByRole('textbox', { name: 'Company name', exact: true }).fill('Different Browser Name');
  await page.getByRole('textbox', { name: 'Company domain (optional)', exact: true }).fill('browser.example');
  await page.getByRole('button', { name: 'Review company', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create company', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Open existing company', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Browser Residential Management', exact: true })).toBeVisible();
  await expect(page.getByText('Company evidence unavailable. Reopen this detail to check again.', {exact: true})).toBeVisible();
  expect(await page.evaluate(() => window.nativeDeskBrowser.fixture.calls.filter(call => call.method === 'localWorkspace.getCompany'))).toEqual([{method: 'localWorkspace.getCompany', input: {accountId: 'browser-local-company'}}]);
  const inventory = await methods(page);
  expect(inventory.filter(name => name === 'localWorkspace.createCompany')).toHaveLength(1);
  expect(inventory.filter(name => name === 'localWorkspace.reviewCompany')).toHaveLength(2);
  expect(inventory.every(name => ['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments', 'localWorkspace.getCompany', 'localWorkspace.reviewCompany', 'localWorkspace.createCompany'].includes(name))).toBe(true);
  await assertClean(page, state);
});

test('an unsent local draft is listed in Today and opens its company with the draft panel in view at both widths', async ({page}, testInfo) => {
  const state = await mount(page);
  await localOnly(page);
  await page.evaluate(async () => {
    const f = window.nativeDeskBrowser.fixture, localApi = f.api.localWorkspace;
    const local = await localApi.get(), retained = await localApi.getCommitments();
    const at = retained.generatedAt, sourceId = 'lenox-source', routeId = 'lenox-route', email = 'info@lenoxmanagement.com';
    const quote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
    const source = {id: sourceId, url: 'https://lenoxmanagement.com/', fetchedAt: at, sha256: 'b'.repeat(64), excerpt: quote, permitted: true};
    const evidence: Awaited<ReturnType<typeof localApi.getCompany>>['snapshot'] = {account: {id: 'lenox', name: 'Lenox Management', domain: 'lenoxmanagement.com', version: 3},
      claims: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'a'.repeat(64),
      routes: [{id: routeId, accountId: 'lenox', version: 1, personId: null, channel: 'email', value: email, purpose: 'business', verification: 'published', evidenceIds: [sourceId]}]};
    f.setLocalSnapshot({...local, accounts: {state: 'available', snapshots: [...(local.accounts.state === 'available' ? local.accounts.snapshots : []),
      {...evidence, preparation: {researched: true, unsentDraft: true, businessRoute: true, nextStep: 'reopen_draft', reason: 'An unsent local draft is saved. Reopen to review it. Saving is not sending.'}}]}});
    f.setCommitments({...retained, localDrafts: [{accountId: 'lenox', draftId: 'lenox-draft', companyLabel: 'Lenox Management', subject: 'Maintenance request coordination at Lenox', revision: 2, updatedAt: at, email}]});
    // Saved evidence and one saved unsent draft for this company only. Every other company keeps the fixture's unavailable detail.
    const getCompany: typeof localApi.getCompany = async input => {
      if (input.accountId !== 'lenox') return fixtureGetCompany(input);
      f.calls.push({method: 'localWorkspace.getCompany', input});
      return {scope: 'local_database', generatedAt: at, snapshot: evidence, sources: [source], links: []};
    };
    const getCompanyDraft: typeof localApi.getCompanyDraft = async input => {
      if (input.accountId !== 'lenox') return fixtureGetCompanyDraft(input);
      f.calls.push({method: 'localWorkspace.getCompanyDraft', input});
      return {stale: false, reason: null, editable: true, draft: {kind: 'local_company_email', status: 'unsent', id: 'lenox-draft', accountId: 'lenox', revision: 2,
        recipientBinding: {routeId, routeVersion: 1, email, personId: null}, accountVersionAtOpen: 3, companyLabel: 'Lenox Management', sourceIds: [sourceId],
        publication: {sourceId, url: source.url, sha256: source.sha256, fetchedAt: at, quote}, subject: 'Maintenance request coordination at Lenox', body: 'Hello Lenox Management team,', createdAt: at, updatedAt: at}};
    };
    const fixtureGetCompany = localApi.getCompany, fixtureGetCompanyDraft = localApi.getCompanyDraft;
    Object.assign(localApi, {getCompany, getCompanyDraft});
    window.nativeDeskBrowser.refresh();
  });
  const row = page.getByRole('button', {name: 'Lenox Management · Local unsent draft · revision 2', exact: true});
  await expect(row).toBeVisible();
  await expect(row).toContainText('Saved locally · revision 2');
  expect(await row.textContent()).not.toMatch(/worker|owner|send/i);
  // The unpaired Mac shows one quiet line; the connection details stay collapsed.
  await expect(page.getByText('Cloud work is paused on this Mac. Local work continues.', {exact: true})).toBeVisible();
  await expect(page.getByText(/The daily snapshot is incomplete/)).toHaveCount(0);
  expect(await page.locator('.native-desk__connection').evaluate(el => (el as HTMLDetailsElement).open)).toBe(false);
  const panel = page.getByRole('region', {name: 'Company draft', exact: true});
  const focusInPanel = () => page.evaluate(() => document.activeElement?.closest('section[aria-label="Company draft"]') !== null);
  for (const width of [1440, 1050]) {
    await page.setViewportSize({width, height: width === 1440 ? 900 : 700});
    await page.evaluate(() => window.nativeDeskBrowser.navigate('today'));
    await row.click();
    await expect(page.getByRole('heading', {name: 'Lenox Management', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Local account · Lenox Management', exact: true})).toHaveAttribute('aria-current', 'true');
    await expect(panel).toBeInViewport();
    await expect.poll(focusInPanel).toBe(true);
    // The Accounts step control produces the same visible change.
    await page.getByRole('button', {name: 'Close details', exact: true}).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', {name: 'Reopen draft · Lenox Management', exact: true}).click();
    await expect(panel).toBeInViewport();
    await expect.poll(focusInPanel).toBe(true);
    await page.screenshot({path: testInfo.outputPath(`local-draft-continuation-${width}.png`), animations: 'disabled'});
  }
  const audit = await new AxeBuilder({page}).analyze();
  expect(audit.violations.filter(issue => issue.impact === 'critical' || issue.impact === 'serious')).toEqual([]);
  expect((await methods(page)).filter(method => !['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments', 'localWorkspace.getCompany', 'localWorkspace.getCompanyDraft'].includes(method))).toEqual([]);
  await assertClean(page, state);
});
