import Papa from 'papaparse';

export type CsvSourceKind = 'csv' | 'spreadsheet_paste';

export type CsvRow = {
  rowNumber: number;
  values: string[];
};

export type CsvParseError = {
  rowNumber: number;
  field: string | null;
  code: 'INVALID_HEADER' | 'DUPLICATE_HEADER' | 'PARSE_ERROR';
  message: string;
};

export type ParsedCsvSource = {
  columns: string[];
  rows: CsvRow[];
  errors: CsvParseError[];
};

const MAX_ERRORS = 20;
const MAX_MESSAGE_LENGTH = 200;

/** Single-line, bounded message with no stack frames or filesystem paths. */
const safeMessage = (message: string): string => (
  message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_LENGTH)
);

const isBlankRecord = (record: string[]): boolean => (
  record.every((cell) => cell.trim().length === 0)
);

/**
 * Parses CSV or tab-delimited spreadsheet-paste content into trimmed cells.
 *
 * Blank records are filtered after parsing, preserving original record numbers.
 * The first nonblank record is the header. A quoted multiline cell is one record, so
 * these numbers are not physical line numbers. Errors are renderer-safe.
 */
export function parseCsvSource(
  content: string,
  kind: CsvSourceKind = 'csv',
): ParsedCsvSource {
  const source = content.replace(/^\uFEFF/, '');
  // Match the active import's greedy delimiter detection without discarding
  // blank records from the actual parse. A one-column source defaults to comma.
  const delimiter = kind === 'spreadsheet_paste' ? '\t' : Papa.parse<string[]>(source, {
    header: false, skipEmptyLines: 'greedy', preview: 10,
  }).meta.delimiter;
  const parsed = Papa.parse<string[]>(source, {
    header: false,
    skipEmptyLines: false,
    delimiter,
  });

  const records = parsed.data;
  const headerIndex = Math.max(0, records.findIndex((record) => !isBlankRecord(record)));
  const columns = (records[headerIndex] ?? []).map((cell) => cell.trim());
  const errors: CsvParseError[] = [];

  if (columns.length === 0 || columns.some((column) => column.length === 0)) {
    errors.push({
      rowNumber: headerIndex + 1, field: null, code: 'INVALID_HEADER',
      message: 'Headers must be present and non-blank.',
    });
  }
  if (new Set(columns).size !== columns.length) {
    errors.push({
      rowNumber: headerIndex + 1, field: null, code: 'DUPLICATE_HEADER',
      message: 'Headers must be unique.',
    });
  }
  for (const parseError of parsed.errors.slice(0, MAX_ERRORS)) {
    errors.push({
      rowNumber: Math.max(1, (parseError.row ?? 0) + 1),
      field: null,
      code: 'PARSE_ERROR',
      message: safeMessage(parseError.message),
    });
  }

  const rows: CsvRow[] = [];
  for (let index = headerIndex + 1; index < records.length; index += 1) {
    const record = records[index]!;
    if (isBlankRecord(record)) continue;
    if (record.length !== columns.length && errors.length < MAX_ERRORS) {
      errors.push({
        rowNumber: index + 1, field: null, code: 'PARSE_ERROR',
        message: 'The record has a different number of cells than the header.',
      });
    }
    rows.push({
      rowNumber: index + 1,
      values: columns.map((_, columnIndex) => (record[columnIndex] ?? '').trim()),
    });
  }

  return { columns, rows, errors: errors.slice(0, MAX_ERRORS) };
}
