import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { EmailDraft, OutreachApi, OutreachStatus } from '../../../shared/contracts/outreachContract';
import { OutboundComposer } from './OutboundComposer';
import { emailDraftSession } from './emailDraftSession';

// Real component markup/CSS in an isolated browser. No app, provider or profile is opened.
const css = ['design/tokens.css', 'design/themes.css', 'design/base.css', 'features/leadInspector/leadInspector.css']
  .map(path => readFileSync(`src/renderer/${path}`, 'utf8')).join('\n');
let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

it.each(['light', 'dark'])('keeps action geometry stable across blur-save start and completion in %s', async theme => {
  const setup: OutreachStatus = { model: 'unconfigured', modelName: '', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' };
  const draft: EmailDraft = { id: 'draft', personId: 'kevin', salesCycleId: 'cycle', contactMethodId: 'email', recipient: 'kevin@example.com',
    subject: 'Initial subject', body: 'Initial body', revision: 1, status: 'draft', generation: 'model', messageId: null,
    notice: 'Opening and editing this draft never sends.', updatedAt: '2026-09-08T12:00:00.000Z' };
  let finish!: (value: EmailDraft) => void;
  const api: OutreachApi = { status: async () => setup, configure: async () => setup, connectGmail: async () => setup, disconnectGmail: async () => setup,
    openDraft: async () => draft, saveDraft: () => new Promise(done => { finish = done; }), generateDraft: async () => draft, sendDraft: async () => draft, inspectLocalAuthority: async (): Promise<never> => { throw Error('Static markup does not inspect authority'); } };
  const session = emailDraftSession(api, 'kevin', 'email'); await session.open();
  session.edit('subject', 'Reviewed subject'); session.edit('body', 'Latest edited body');
  const markup = () => renderToStaticMarkup(<OutboundComposer channel="email" recipientLabel="kevin@example.com" personId="kevin" contactMethodId="email" api={api} onClose={() => undefined} />);
  const before = markup(); const pending = session.flush(); const during = markup();
  finish({ ...draft, subject: 'Reviewed subject', body: 'Latest edited body', revision: 2, generation: 'edited', notice: null });
  await pending; const after = markup();
  const page = await browser.newPage({ viewport: { width: 440, height: 1100 } });
  try {
    const positions: number[][] = [];
    for (const content of [before, during, after]) {
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>${content}</body></html>`);
      const values: number[] = [];
      for (const name of ['Send', 'Save draft', 'Close draft']) {
        const box = await page.getByRole('button', { name, exact: true }).boundingBox();
        expect(box).not.toBeNull(); values.push(box!.x, box!.y, box!.width, box!.height);
      }
      positions.push(values);
    }
    // Moving a pointer target between mousedown's blur and mouseup loses the click.
    expect(positions[1]).toEqual(positions[0]);
    expect(positions[2]).toEqual(positions[0]);
    expect(session.snapshot().body).toBe('Latest edited body');
  } finally { await page.close(); }
});
