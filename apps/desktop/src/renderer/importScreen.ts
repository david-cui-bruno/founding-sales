import { button, element } from './firmDom.ts';
import {
  IMPORT_FORMAT_LINES,
  OUTCOME_LABELS,
  commitLine,
  committableCount,
  fileRefusalSentence,
  importSummary,
  issueLine,
  matchLine,
  resultsSummary,
  rowDetail,
} from './captureView.ts';
import type { ImportFile, ImportView } from './firmWorkspaceContract.ts';

/**
 * The Import screen (lane g84, audit item G02): choose or paste a CSV, read the server's
 * preview of every row, press Import.
 *
 * Nothing is imported until the button is pressed, and the button commits exactly the
 * rows the preview marked as a new firm or an added contact. A row to fix says which
 * column and why, in the words `captureView.ts` gives each code; a file refused whole
 * says which header or which line. The file is read here — `File.text()`, no network,
 * the page's `connect-src 'none'` untouched — and handed to the main process, which keeps
 * it for the commit and gives this page only what the server said about it.
 */

export interface ImportScreenOptions {
  readonly view: ImportView;
  readonly actionsEnabled: boolean;
  readonly onPreview: (file: ImportFile) => void;
  readonly onCommit: () => void;
  readonly onReset: () => void;
  readonly onDone: () => void;
}

function renderChooser(section: HTMLElement, options: ImportScreenOptions): void {
  const chooser = element('div', { className: 'import-chooser', testId: 'import-chooser' });
  const file = element('input', { testId: 'import-file' });
  file.type = 'file';
  file.accept = '.csv,text/csv';
  file.disabled = !options.actionsEnabled;
  file.addEventListener('change', () => {
    const chosen = file.files?.[0];
    if (chosen === undefined) return;
    void (async () => {
      options.onPreview({ csv: await chosen.text(), fileName: chosen.name });
    })();
  });
  chooser.append(file);

  const paste = element('textarea', { testId: 'import-paste' });
  paste.placeholder = 'Or paste the file here, header row first';
  paste.disabled = !options.actionsEnabled;
  chooser.append(paste);
  const preview = button('Preview', 'import-preview', options.actionsEnabled);
  preview.addEventListener('click', () => {
    if (paste.value.trim().length === 0) {
      paste.setAttribute('aria-invalid', 'true');
      return;
    }
    options.onPreview({ csv: paste.value, fileName: 'Pasted text' });
  });
  chooser.append(preview);
  section.append(chooser);
}

function renderPreview(section: HTMLElement, options: ImportScreenOptions): void {
  const preview = options.view.preview;
  if (preview === null) return;
  const head = element('p', { className: 'summary', testId: 'import-summary' });
  head.textContent = `${options.view.fileName ?? 'File'} · ${importSummary(preview)}`;
  section.append(head);

  const list = element('ul', { className: 'rows import-rows', testId: 'import-rows' });
  for (const row of preview.rows) {
    const item = element('li', { testId: 'import-row' });
    item.dataset['outcome'] = row.outcome;
    item.dataset['rowNumber'] = String(row.rowNumber);
    const line = element('div', { className: 'row' });
    const main = element('div', { className: 'row-main' });
    main.append(element('span', { className: 'name', text: `Row ${String(row.rowNumber)} · ${row.firm.name || '(no firm name)'}` }));
    const detail = rowDetail(row);
    if (detail !== '') main.append(element('span', { className: 'why', text: detail }));
    const match = matchLine(row);
    if (match !== null) main.append(element('span', { className: 'why', text: `To ${match}`, testId: 'import-row-match' }));
    for (const issue of row.issues) {
      main.append(element('p', { className: 'field-issue', text: issueLine(issue), testId: 'import-issue' }));
    }
    line.append(main);
    const tone = row.outcome === 'invalid' ? 'tag tag-stop' : row.outcome === 'duplicate' ? 'tag' : 'tag tag-ok';
    line.append(element('span', { className: tone, text: OUTCOME_LABELS[row.outcome], testId: 'import-row-outcome' }));
    item.append(line);
    list.append(item);
  }
  section.append(list);

  const count = committableCount(preview);
  const actions = element('div', { className: 'form-actions' });
  if (options.view.results === null) {
    const commit = button(
      count === 1 ? 'Import 1 row' : `Import ${String(count)} rows`,
      'import-commit',
      options.actionsEnabled && count > 0,
    );
    commit.className = 'btn btn-primary';
    commit.addEventListener('click', () => {
      commit.disabled = true;
      options.onCommit();
    });
    actions.append(commit);
  }
  const reset = button('Choose another file', 'import-reset', true);
  reset.className = 'btn btn-quiet';
  reset.addEventListener('click', () => {
    options.onReset();
  });
  actions.append(reset);
  section.append(actions);
}

function renderResults(section: HTMLElement, options: ImportScreenOptions): void {
  const results = options.view.results;
  if (results === null) return;
  const block = element('div', { className: 'import-results', testId: 'import-results' });
  block.append(element('h2', { className: 'section-head', text: 'Imported' }));
  block.append(element('p', { text: resultsSummary(results.results), testId: 'import-results-summary' }));
  const refused = results.results.filter(result => result.status === 'refused');
  if (refused.length > 0) {
    const list = element('ul', { className: 'rows' });
    for (const result of refused) list.append(element('li', { className: 'field-issue', text: commitLine(result), testId: 'import-refused-row' }));
    block.append(list);
  }
  const done = button('Open the pipeline', 'import-done', true);
  done.className = 'btn';
  done.addEventListener('click', () => {
    options.onDone();
  });
  block.append(done);
  section.append(block);
}

export function renderImportScreen(root: HTMLElement, options: ImportScreenOptions): void {
  const section = element('section', { className: 'capture import', testId: 'import-screen' });
  for (const line of IMPORT_FORMAT_LINES) section.append(element('p', { className: 'quiet', text: line }));

  const refusal = options.view.fileRefusal;
  if (refusal !== null) {
    section.append(element('p', { className: 'banner banner-warning', text: fileRefusalSentence(refusal), testId: 'import-file-refused' }));
  }
  if (options.view.preview === null) renderChooser(section, options);
  else renderPreview(section, options);
  renderResults(section, options);
  root.append(section);
}
