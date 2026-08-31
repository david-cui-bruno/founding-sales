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
 * Every physical record is parsed (Papa's `skipEmptyLines: 'greedy'` filter is
 * applied after parsing) so blank lines are dropped while each surviving row
 * keeps its exact source row number: the header is row 1 and the first data
 * record is row 2. Errors are bounded and safe for the renderer.
 */
export function parseCsvSource(
  content: string,
  kind: CsvSourceKind = 'csv',
): ParsedCsvSource {
  const parsed = Papa.parse<string[]>(content.replace(/^\uFEFF/, ''), {
    header: false,
    skipEmptyLines: false,
    delimiter: kind === 'spreadsheet_paste' ? '\t' : ',',
  });

  const records = parsed.data;
  const columns = (records[0] ?? []).map((cell) => cell.trim());
  const errors: CsvParseError[] = [];

  if (columns.length === 0 || columns.some((column) => column.length === 0)) {
    errors.push({
      rowNumber: 1, field: null, code: 'INVALID_HEADER',
      message: 'Headers must be present and non-blank.',
    });
  }
  if (new Set(columns).size !== columns.length) {
    errors.push({
      rowNumber: 1, field: null, code: 'DUPLICATE_HEADER',
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
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index]!;
    if (isBlankRecord(record)) continue;
    rows.push({
      rowNumber: index + 1,
      values: columns.map((_, columnIndex) => (record[columnIndex] ?? '').trim()),
    });
  }

  return { columns, rows, errors: errors.slice(0, MAX_ERRORS) };
}
