import { useEffect, useRef, useState, type JSX } from 'react';
import { reasonSentence } from '@fss/contracts';
import type { BriefImportRow, BriefImportView } from '../../shared/briefImport.ts';
import { importBridge, operations } from '../app/bridges.ts';
import { Alert } from '../ui/alert.tsx';
import { Button } from '../ui/button.tsx';
import { Row, RowMain, Rows, Section, Tag } from '../ui/layout.tsx';

/**
 * Firms → Import → "Import prepared briefs (JSON)…" (lane PB), an administrator's action.
 *
 * The CSV import's shape: macOS's panel is opened by the main process, which reads the
 * file, checks each row and asks the server which firm each row names (the CSV importer's
 * matcher: external id, then website domain, then name). The window is given the preview —
 * matched, unmatched, ambiguous and invalid rows — never the briefs. "Import N briefs" sends
 * one set command per matched row, each with its own receipt; a row that is refused says
 * why on its own line and the rest still land. The preview is the main process's, so it
 * survives leaving the screen and coming back (UI criterion 7).
 */

const FILE_ERRORS: Readonly<Record<NonNullable<BriefImportView['fileError']>, string>> = Object.freeze({
  not_json: 'That file is not JSON. Choose the prepared-brief file (a .json array).',
  not_array: 'That JSON is not a list of briefs. The file must be an array of rows.',
  empty: 'That file has no rows.',
  too_many_rows: 'That file has more than 2,000 rows. Split it and import each part.',
  too_large: 'That file is too large to import.',
});

const ISSUE_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  brief: 'the brief is missing, blank or over 4,000 characters',
  sources: 'a source is not an https link with a label, or there are more than 30',
  observed_on: 'observed_on is not a date (YYYY-MM-DD)',
  prepared_by: 'prepared_by is missing or over 200 characters',
  external_id: 'external_id is not usable',
  website: 'website is not usable',
  firm_name: 'firm_name is not usable',
  firm: 'the row names no firm, or has a field Callie does not know',
});

const MATCHED_ON: Readonly<Record<string, string>> = Object.freeze({ external_id: 'external id', domain: 'website', name: 'name' });

export function briefRowDetail(row: BriefImportRow): string {
  if (row.status === 'invalid') return `Not imported: ${ISSUE_FIELDS[row.issue ?? 'firm'] ?? ISSUE_FIELDS['firm'] ?? ''}.`;
  if (row.status === 'unmatched') return 'No firm in Callie matches this row.';
  if (row.status === 'ambiguous') return `More than one firm matches by ${row.issue === 'external_id' ? 'external id' : row.issue === 'website' ? 'website' : 'name'}; not imported.`;
  const to = `To ${row.firmName ?? 'the firm'} (by ${MATCHED_ON[row.matchedOn ?? ''] ?? 'match'}) · ${String(row.sourceCount)} source${row.sourceCount === 1 ? '' : 's'}`;
  if (row.result === null) return to;
  return row.result === 'saved' ? `${to} · imported` : `${to} · ${reasonSentence(row.result)}`;
}

const TONE: Readonly<Record<BriefImportRow['status'], 'ok' | 'warn' | 'none'>> = { matched: 'ok', unmatched: 'none', ambiguous: 'warn', invalid: 'warn' };
const STATUS_LABEL: Readonly<Record<BriefImportRow['status'], string>> = { matched: 'Matched', unmatched: 'Unmatched', ambiguous: 'Ambiguous', invalid: 'To fix' };

export function BriefImport({ enabled }: { readonly enabled: boolean }): JSX.Element | null {
  const [view, setView] = useState<BriefImportView | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const api = operations();
  const files = importBridge();

  useEffect(() => {
    mounted.current = true;
    void api?.read('firms.briefImportState', {}).then(answer => {
      if (mounted.current) setView(answer);
    });
    return () => {
      mounted.current = false;
    };
  }, [api]);

  if (api === undefined || files === undefined) return null;

  const run = (work: () => Promise<BriefImportView>): void => {
    setBusy(true);
    void work()
      .then(answer => {
        if (mounted.current) setView(answer);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const rows = view?.rows ?? [];
  const toSend = rows.filter(row => row.status === 'matched' && row.result !== 'saved').length;
  const saved = rows.filter(row => row.result === 'saved').length;
  const refused = rows.filter(row => row.result !== null && row.result !== 'saved').length;
  const counts = (['matched', 'unmatched', 'ambiguous', 'invalid'] as const)
    .map(status => [status, rows.filter(row => row.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${String(count)} ${STATUS_LABEL[status].toLowerCase()}`)
    .join(' · ');

  return (
    <Section data-testid="brief-import" title="Prepared briefs">
      <p className="text-xs text-muted-foreground">
        A JSON array of rows with external_id, website or firm_name, then brief, sources (each an https url and a label), observed_on and prepared_by. Rows match firms already in Callie the way a CSV import does.
      </p>
      {view?.fileError == null ? null : (
        <Alert tone="warning" data-testid="brief-import-file-error" className="mt-3">
          {FILE_ERRORS[view.fileError]}
        </Alert>
      )}
      {view?.reason == null ? null : (
        <Alert tone="warning" data-testid="brief-import-reason" className="mt-3">
          {reasonSentence(view.reason)}
        </Alert>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" data-testid="brief-import-choose" disabled={!enabled || busy} onClick={() => run(async () => await files.chooseBriefs())}>
          Import prepared briefs (JSON)…
        </Button>
        {view?.fileName == null || rows.length === 0 ? null : (
          <span data-testid="brief-import-summary" className="text-sm text-muted-foreground">
            {`${view.fileName} · ${counts}`}
          </span>
        )}
      </div>
      {rows.length === 0 ? null : (
        <>
          <Rows data-testid="brief-import-rows">
            {rows.map(row => (
              <Row key={row.index} data-testid="brief-import-row" data-status={row.status} data-result={row.result ?? ''}>
                <RowMain line={`Row ${String(row.index)} · ${row.label}`} detail={<span>{briefRowDetail(row)}</span>} />
                <Tag tone={row.result !== null && row.result !== 'saved' ? 'warn' : TONE[row.status]}>
                  {row.result === 'saved' ? 'Imported' : row.result !== null ? 'Refused' : STATUS_LABEL[row.status]}
                </Tag>
              </Row>
            ))}
          </Rows>
          <div className="mt-4 flex items-center gap-2">
            <Button data-testid="brief-import-commit" disabled={!enabled || busy || toSend === 0} onClick={() => run(async () => await api.command('firms.briefImportCommit', {}))}>
              {toSend === 1 ? 'Import 1 brief' : `Import ${String(toSend)} briefs`}
            </Button>
            {saved + refused === 0 ? null : (
              <span data-testid="brief-import-results" className="text-sm text-muted-foreground">
                {`${String(saved)} imported${refused === 0 ? '' : ` · ${String(refused)} refused`}`}
              </span>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
