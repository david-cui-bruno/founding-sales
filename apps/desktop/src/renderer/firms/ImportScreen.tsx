import type { JSX } from 'react';
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
} from '../captureView.ts';
import type { ImportView } from '../firmWorkspaceContract.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Row, RowMain, Rows, Section, Tag } from '../ui/layout.tsx';

/**
 * The Import screen (lane g84, audit item G02): choose a CSV, read the server's preview
 * of every row, press Import.
 *
 * Nothing is imported until the button is pressed, and the button commits exactly the
 * rows the preview marked as a new firm or an added contact. A row to fix says which
 * column and why, in the words `captureView.ts` gives each code; a file refused whole
 * says which header or which line.
 *
 * **The file is chosen by macOS and read by the main process** (1.0.13). Until then the
 * page held an `<input type="file">`, read the file itself and sent up to half a megabyte
 * of somebody's prospect list across the bridge; now it presses a button and is given
 * what the server said about whatever the person picked. The paste box went with it: it
 * was a second way to put the same list in the one process that should not hold it.
 */

export function ImportScreen({
  view,
  actionsEnabled,
  onChooseFile,
  onCommit,
  onDone,
}: {
  readonly view: ImportView;
  readonly actionsEnabled: boolean;
  onChooseFile(): void;
  onCommit(): void;
  onDone(): void;
}): JSX.Element {
  const preview = view.preview;
  const count = committableCount(preview);
  return (
    <div data-testid="import-screen" className="mt-5 flex flex-col">
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {IMPORT_FORMAT_LINES.map(line => (
          <p key={line}>{line}</p>
        ))}
      </div>

      {view.fileRefusal === null ? null : (
        <Alert tone="warning" data-testid="import-file-refused" className="mt-3">
          {fileRefusalSentence(view.fileRefusal)}
        </Alert>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button data-testid="import-choose" disabled={!actionsEnabled} onClick={onChooseFile}>
          {preview === null ? 'Choose a CSV file…' : 'Choose another file…'}
        </Button>
        {preview === null ? null : (
          <span data-testid="import-summary" className="text-sm text-muted-foreground">
            {`${view.fileName ?? 'File'} · ${importSummary(preview)}`}
          </span>
        )}
      </div>

      {preview === null ? null : (
        <Section title="Rows" count={preview.rows.length}>
          <Rows data-testid="import-rows">
            {preview.rows.map(row => {
              const detail = rowDetail(row);
              const match = matchLine(row);
              return (
                <Row key={row.rowNumber} data-testid="import-row" data-outcome={row.outcome} data-row-number={row.rowNumber}>
                  <RowMain
                    line={`Row ${String(row.rowNumber)} · ${row.firm.name === '' ? '(no firm name)' : row.firm.name}`}
                    detail={
                      <>
                        {detail === '' ? null : <span>{detail}</span>}
                        {match === null ? null : (
                          <span data-testid="import-row-match">{`${detail === '' ? '' : ' · '}To ${match}`}</span>
                        )}
                        {row.issues.map(issue => (
                          <span key={`${issue.column}:${issue.code}`} data-testid="import-issue" className="block text-destructive">
                            {issueLine(issue)}
                          </span>
                        ))}
                      </>
                    }
                  />
                  <Tag
                    data-testid="import-row-outcome"
                    tone={row.outcome === 'invalid' ? 'warn' : row.outcome === 'duplicate' ? 'none' : 'ok'}
                  >
                    {OUTCOME_LABELS[row.outcome]}
                  </Tag>
                </Row>
              );
            })}
          </Rows>
          {view.results === null ? (
            <div className="mt-4">
              <Button data-testid="import-commit" disabled={!actionsEnabled || count === 0} onClick={onCommit}>
                {count === 1 ? 'Import 1 row' : `Import ${String(count)} rows`}
              </Button>
            </div>
          ) : null}
        </Section>
      )}

      {view.results === null ? null : (
        <Section data-testid="import-results" title="Imported">
          <p data-testid="import-results-summary" className="py-1 text-sm">
            {resultsSummary(view.results.results)}
          </p>
          {view.results.results.some(result => result.status === 'refused') ? (
            <Rows>
              {view.results.results
                .filter(result => result.status === 'refused')
                .map(result => (
                  <Row key={result.rowNumber} data-testid="import-refused-row">
                    <RowMain line={<span className="text-destructive">{commitLine(result)}</span>} />
                  </Row>
                ))}
            </Rows>
          ) : null}
          <div className="mt-4">
            <Button variant="outline" data-testid="import-done" onClick={onDone}>
              Back to Firms
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}
