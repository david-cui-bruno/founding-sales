/**
 * RI Rental Registry targeted lookup (backlog F5 v0).
 *
 * Looks up ONE property address in the public RI Rental Registry
 * (ridoh-ri.tolemi.com, RIDOH/Tolemi) through the public search UI — the
 * interface the operator exposes — and prints the registration facts as JSON:
 * registration status, unit count, lead-certificate status, owners and
 * managers with any published contact fields (name, address, email, phone).
 *
 * Access-path policy (cloud/VERIFIED_SOURCES.md): UI only, one lookup per
 * invocation, human-speed waits. No GraphQL wire-format synthesis, no bulk
 * scraping. Landlord contact info here is public by statute (RIGL 34-18-58).
 *
 * Usage:
 *   npx playwright install chromium   # once
 *   node scripts/registryLookup.mjs "2 Old Orchard Farm Rd, Bristol"
 *   node scripts/registryLookup.mjs --property-url https://ridoh-ri.tolemi.com/property/Ridoh-RI/48046344
 */
import { chromium } from 'playwright';

const arg = process.argv.slice(2);
if (arg.length === 0) {
  console.error('usage: node scripts/registryLookup.mjs "<address>" | --property-url <url>');
  process.exit(2);
}

const BASE = 'https://ridoh-ri.tolemi.com/';

function parseDetail(text) {
  const grab = (label) => {
    const re = new RegExp(`${label}\\n([^\\n]+)`);
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const people = (section) => {
    const idx = text.indexOf(section);
    if (idx < 0) return [];
    const slice = text.slice(idx, idx + 1200);
    // Entries look like: Name \n Address \n <line> [\n Email \n <line>] [\n Phone \n <line>]
    const out = [];
    const lines = slice.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^(Rental Property|Chat with us|Print|CSV)/.test(line)) break;
      if (line === 'Address' || line === 'Email' || line === 'Phone') {
        const key = line.toLowerCase();
        const value = lines[i + 1] ?? null;
        if (out.length > 0) out[out.length - 1][key] = value;
        i += 1;
      } else {
        out.push({ name: line });
      }
    }
    return out;
  };
  return {
    parcelId: grab('Parcel ID:?') ?? (text.match(/Parcel ID: ?([^\n]+)/) || [])[1] ?? null,
    registrationStatus: grab('Registration Status'),
    registeredUnits: grab('Number of Registered Rental Units'),
    leadCertificateStatus: grab('Lead Certificate Status'),
    activeLeadCertificate: grab('Active Lead Certificate'),
    owners: people('Rental Property Owners'),
    managers: people('Rental Property Managers'),
  };
}

const browser = await chromium.launch({
  headless: true,
  // Reuse the system Chrome-for-Testing install; avoids a playwright browser
  // download whose pinned build may not be cached on this machine.
  executablePath: '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
});
let page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
try {
  if (arg[0] === '--property-url') {
    await page.goto(arg[1], { waitUntil: 'networkidle', timeout: 60_000 });
  } else {
    const address = arg.join(' ');
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
    // Welcome modal renders LATE (after networkidle). Wait for it, close it
    // via DOM (the wrap lingers and intercepts pointer events, so Playwright
    // actionability clicks would spin), and confirm the dialog is gone before
    // touching the page — otherwise keystrokes land inside the modal.
    await page.locator('.ant-modal').waitFor({ timeout: 15_000 }).catch(() => {});
    for (let i = 0; i < 10; i += 1) {
      const dismissed = await page.evaluate(() => {
        const dialog = document.querySelector('.ant-modal');
        if (dialog === null || dialog.offsetParent === null) return true;
        // This modal variant has an OK button (sometimes an X too).
        const ok = [...dialog.querySelectorAll('button')]
          .find((b) => /^(ok|got it|close)$/i.test(b.textContent.trim()));
        (ok ?? dialog.querySelector('.ant-modal-close'))?.click();
        return false;
      });
      if (dismissed) break;
      await page.waitForTimeout(1_000);
    }
    // Focus the search box via DOM, then type with real key events at human
    // speed so the site's autocomplete populates.
    await page.evaluate(() => {
      const input = [...document.querySelectorAll('input[type=text]')]
        .find((e) => /address or parcel/i.test(e.placeholder || ''));
      if (input) input.focus();
    });
    await page.keyboard.type(address, { delay: 120 });
    // Google Places-style or antd autocomplete list.
    const suggestion = page.locator('.pac-item, .ant-select-item, [class*="suggestion"] [class*="item"]').first();
    try {
      await suggestion.waitFor({ timeout: 8_000 });
      await suggestion.click();
    } catch {
      await page.keyboard.press('Enter');
      // Fallback: the inline magnifier triggers the search when Enter is a
      // no-op. Both paths may navigate, which destroys the evaluate context —
      // that is success, not failure.
      await page.evaluate(() => {
        const icon = document.querySelector('.ant-input-suffix .anticon-search');
        if (icon) icon.click();
      }).catch(() => {});
    }
    // Either a property page opens, or the map pans: try the List view row.
    await page.waitForTimeout(4_000);
    if (!page.url().includes('/property/')) {
      await page.evaluate(() => {
        const toggle = [...document.querySelectorAll('button,div,span')]
          .find((e) => e.textContent.trim() === 'List' && e.offsetParent);
        if (toggle) toggle.click();
      });
      await page.waitForTimeout(2_000);
      const streetToken = address.split(',')[0].trim().toUpperCase();
      const row = page.locator('td a').filter({ hasText: new RegExp(streetToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first();
      try {
        await row.waitFor({ timeout: 10_000 });
      } catch {
        // Not in the registry (or the search found nothing): report honestly.
        console.log(JSON.stringify({ url: page.url(), found: false, address }, null, 2));
        await browser.close();
        process.exit(0);
      }
      // React row handler lives above the anchor: real mouse click on the cell.
      await row.click({ force: true });
    }
    // SPA pushState navigation OR a popup tab: poll every page in the context.
    let detailPage = null;
    for (let i = 0; i < 30 && detailPage === null; i += 1) {
      detailPage = page.context().pages().find((p2) => p2.url().includes('/property/')) ?? null;
      if (detailPage === null) await page.waitForTimeout(500);
    }
    if (detailPage === null) {
      console.log(JSON.stringify({ url: page.url(), found: false, address, note: 'row click did not open property page' }, null, 2));
      await browser.close();
      process.exit(0);
    }
    page = detailPage;
  }
  await page.waitForTimeout(3_000);
  const modalClose = page.locator('.ant-modal-close');
  if (await modalClose.count()) await modalClose.first().click().catch(() => {});
  const text = await page.evaluate(() => document.body.innerText);
  const detail = parseDetail(text);
  console.log(JSON.stringify({ url: page.url(), ...detail }, null, 2));
} finally {
  await browser.close();
}
