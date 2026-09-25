import { expect, test } from 'playwright/test';
import {
  EMPTY_DRAFT,
  FIRM_ID,
  crmState,
  importPreviewView,
  pipelineView,
  startCrmTestServer,
  unplacedIdentity,
  type CrmTestServer,
} from './support/crmTestServer.ts';

/**
 * Add firm and Import in the Firms window, end to end against the generated test server
 * (lane g84, audit item G02).
 *
 * The renderer is the shipped file and only the bridge is scripted, so these prove what a
 * person sees and can press: the two buttons above the pipeline, the firms no column
 * holds, the form that sends exactly what was typed and comes back marked, and the import
 * that previews every row before anything is committed.
 *
 * **The vacuous-pass trap.** A form spec that only ever submits valid values passes with
 * the field marks deleted. One spec here renders a refusal and asserts each field's mark,
 * its sentence and the value that was typed.
 */

let server: CrmTestServer;

test.afterEach(async () => {
  await server.stop();
});

const pipelineWithUnplaced = () => ({
  ...pipelineView(),
  unplacedFirms: [unplacedIdentity('99999999-9999-4999-8999-999999999990', 'Aspen Test Wealth')],
});

test('the pipeline offers Add firm and, to an admin, Import CSV, and lists the firms no column holds', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', role: 'admin', firm: null, pipeline: pipelineWithUnplaced() }));
  await page.goto(server.url);

  await expect(page.getByTestId('open-add-firm')).toBeEnabled();
  await expect(page.getByTestId('open-import')).toBeEnabled();
  await expect(page.getByTestId('unplaced-firm')).toHaveCount(1);
  await expect(page.getByTestId('unplaced-firms')).toContainText('Not in the pipeline yet');
  await page.getByTestId('unplaced-open-firm').click();
  expect(server.calls.at(-1)).toEqual({ method: 'openFirm', argument: { firmId: '99999999-9999-4999-8999-999999999990' } });
});

test('a salesperson is offered Add firm and not Import', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', role: 'salesperson', firm: null, pipeline: pipelineView() }));
  await page.goto(server.url);
  await expect(page.getByTestId('open-add-firm')).toBeVisible();
  await expect(page.getByTestId('open-import')).toHaveCount(0);
});

test('Add firm sends exactly what was typed, and lands on the new firm', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', role: 'admin', firm: null, pipeline: pipelineView() }));
  await page.goto(server.url);
  await page.getByTestId('open-add-firm').click();
  await expect(page.getByTestId('heading')).toHaveText('Add firm');

  await page.getByTestId('add-firm-name').fill('Aspen Test Wealth');
  await page.getByTestId('add-firm-website').fill('aspen.example.test');
  await page.getByTestId('add-firm-timeZone').selectOption('America/Chicago');
  await page.getByTestId('add-firm-contactName').fill('Kim Placeholder');
  await page.getByTestId('add-firm-contactTitle').fill('Principal');
  await page.getByTestId('add-firm-contactEmail').fill('kim@aspen.example.test');
  await page.getByTestId('add-firm-contactPhone').fill('401 555 0121');
  await page.getByTestId('add-firm-submit').click();

  await expect(page.getByTestId('heading')).toHaveText('Firm');
  await expect(page.getByTestId('banner-info')).toContainText('Firm added.');
  expect(server.calls.find(call => call.method === 'addFirm')?.argument).toEqual({
    name: 'Aspen Test Wealth',
    website: 'aspen.example.test',
    timeZone: 'America/Chicago',
    contactName: 'Kim Placeholder',
    contactTitle: 'Principal',
    contactEmail: 'kim@aspen.example.test',
    contactPhone: '401 555 0121',
  });
});

test('a form with no firm name is not sent, and says why', async ({ page }) => {
  server = await startCrmTestServer(
    crmState({ screen: 'add_firm', role: 'admin', firm: null, addFirm: { draft: EMPTY_DRAFT, issues: [], duplicateFirmId: null } }),
  );
  await page.goto(server.url);
  await page.getByTestId('add-firm-website').fill('aspen.example.test');
  await page.getByTestId('add-firm-submit').click();
  await expect(page.getByTestId('issue-firm_name')).toHaveText('A firm needs a name.');
  await expect(page.getByTestId('add-firm-name')).toHaveAttribute('aria-invalid', 'true');
  expect(server.calls.filter(call => call.method === 'addFirm')).toHaveLength(0);
});

test('a refused form comes back with its values and every field the server named', async ({ page }) => {
  const draft = { ...EMPTY_DRAFT, name: 'Aspen', website: 'not a site', contactEmail: 'kim@@aspen' };
  server = await startCrmTestServer(
    crmState({
      screen: 'add_firm',
      role: 'admin',
      firm: null,
      notice: 'website_invalid',
      addFirm: {
        draft,
        issues: [
          { column: 'website', code: 'website_invalid' },
          { column: 'contact_email', code: 'email_invalid' },
          { column: 'contact_name', code: 'contact_name_missing' },
        ],
        duplicateFirmId: null,
      },
    }),
  );
  await page.goto(server.url);
  await expect(page.getByTestId('banner-warning')).toContainText('Check the fields marked below.');
  await expect(page.getByTestId('add-firm-website')).toHaveValue('not a site');
  await expect(page.getByTestId('add-firm-website')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('issue-website')).toContainText('Not a website Callie can read');
  await expect(page.getByTestId('issue-contact_email')).toHaveText('Not an email address.');
  await expect(page.getByTestId('issue-contact_name')).toContainText('needs a person’s name');
  await expect(page.getByTestId('add-firm-name')).not.toHaveAttribute('aria-invalid', 'true');
});

test('a firm that is already here can be opened from the refusal', async ({ page }) => {
  server = await startCrmTestServer(
    crmState({
      screen: 'add_firm',
      role: 'admin',
      firm: null,
      notice: 'duplicate_in_workspace',
      addFirm: {
        draft: { ...EMPTY_DRAFT, name: 'Northwind', website: 'northwind.example.test' },
        issues: [{ column: 'website', code: 'duplicate_in_workspace' }],
        duplicateFirmId: FIRM_ID,
      },
    }),
  );
  await page.goto(server.url);
  await expect(page.getByTestId('banner-warning')).toContainText('That firm is already here.');
  await page.getByTestId('add-firm-open-duplicate').click();
  expect(server.calls.at(-1)).toEqual({ method: 'openFirm', argument: { firmId: FIRM_ID } });
});

test('Import previews a chosen file row by row, and commits only on the button', async ({ page }) => {
  server = await startCrmTestServer(crmState({ screen: 'pipeline', role: 'admin', firm: null, pipeline: pipelineView() }));
  await page.goto(server.url);
  await page.getByTestId('open-import').click();
  await expect(page.getByTestId('heading')).toHaveText('Import firms');

  const csv = 'firm_name,website,contact_name,contact_email\nAspen Test Wealth,aspen.example.test,Kim Placeholder,kim@aspen.example.test\n';
  await page.getByTestId('import-file').setInputFiles({ name: 'prospects.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByTestId('import-summary')).toContainText('4 rows · 1 new firm · 1 contact added to a firm · 1 already here · 1 to fix');
  expect(server.calls.find(call => call.method === 'previewImport')?.argument).toEqual({ csv, fileName: 'prospects.csv' });
  expect(server.calls.filter(call => call.method === 'commitImport')).toHaveLength(0);

  await expect(page.getByTestId('import-row')).toHaveCount(4);
  await expect(page.getByTestId('import-row-outcome')).toHaveText(['New firm', 'Adds a contact', 'Already here', 'Fix']);
  await expect(page.getByTestId('import-row-match').first()).toHaveText('To the firm on row 2');
  await expect(page.getByTestId('import-issue')).toHaveText([
    'Email: Already on an earlier row of this file.',
    'Phone: Not a number Callie can dial. Use ten digits, or + and the country code.',
  ]);

  await page.getByTestId('import-commit').click();
  await expect(page.getByTestId('import-results-summary')).toHaveText('1 imported · 1 refused');
  await expect(page.getByTestId('import-refused-row')).toHaveText('Row 3 · Email: Already here.');
  await expect(page.getByTestId('banner-warning')).toContainText('Imported, except the rows listed below.');
  expect(server.calls.filter(call => call.method === 'commitImport')).toHaveLength(1);
});

test('a file refused whole says which column', async ({ page }) => {
  server = await startCrmTestServer(
    crmState({
      screen: 'import',
      role: 'admin',
      firm: null,
      import: { fileName: 'x.csv', preview: null, results: null, fileRefusal: { reason: 'csv_column_unknown', column: 'Notes', rowNumber: null } },
    }),
  );
  await page.goto(server.url);
  await expect(page.getByTestId('import-file-refused')).toHaveText('The column “Notes” is not one Callie imports. Remove it or rename it.');
  await expect(page.getByTestId('import-file')).toBeVisible();
});

test('pasted text previews through the same call', async ({ page }) => {
  server = await startCrmTestServer(
    crmState({ screen: 'import', role: 'admin', firm: null, import: { fileName: null, preview: null, results: null, fileRefusal: null } }),
  );
  await page.goto(server.url);
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-paste')).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('import-paste').fill('firm_name\nAspen Test Wealth');
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('import-summary')).toBeVisible();
  expect(server.calls.find(call => call.method === 'previewImport')?.argument).toEqual({
    csv: 'firm_name\nAspen Test Wealth',
    fileName: 'Pasted text',
  });
  // The fixture the server answers with is the four-row preview.
  expect(importPreviewView().preview?.rows).toHaveLength(4);
});
