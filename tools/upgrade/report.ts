/**
 * The printed evidence. One writer, so that the CI artifact and the terminal are the
 * same bytes: a release record cites an artifact id, and an artifact nobody can compare
 * with what the operator saw is not evidence. One writer is also one place to redact.
 */
import { redactConnectionStrings } from './redact.ts';

export class Report {
  readonly #lines: string[] = [];

  /**
   * Every line, from every source, goes through the redactor here.
   *
   * Redacting at each call site was not enough: the constraint runner's captured output
   * reached the artifact unredacted (GPT-6 review of PR 314, P2). `line` is the single
   * boundary — `step` and `table` both funnel through it — so a line that carries a
   * connection URL cannot reach the evidence whoever wrote it.
   */
  line(text = ''): void {
    this.#lines.push(redactConnectionStrings(text));
  }

  /** A step's one line: number, what it did, and its wall-clock seconds. */
  step(number: number, what: string, seconds: number, note = ''): void {
    this.line(
      `step ${String(number).padStart(2, ' ')}  ${what.padEnd(52, ' ')} ${seconds.toFixed(2).padStart(7, ' ')}s${note === '' ? '' : `  ${note}`}`,
    );
  }

  /** A fixed-width table with a header rule. */
  table(headers: readonly string[], rows: readonly (readonly string[])[], indent = '  '): void {
    if (rows.length === 0) {
      this.line(`${indent}(none)`);
      return;
    }
    const widths = headers.map((header, column) =>
      Math.max(header.length, ...rows.map(row => (row[column] ?? '').length)),
    );
    const render = (cells: readonly string[]): string =>
      indent + cells.map((cell, column) => cell.padEnd(widths[column] ?? 0, ' ')).join('  ').trimEnd();
    this.line(render(headers));
    this.line(indent + widths.map(width => '-'.repeat(width)).join('  '));
    for (const row of rows) this.line(render(row));
  }

  toString(): string {
    return `${this.#lines.join('\n')}\n`;
  }
}

/** Seconds since `started`, from `process.hrtime.bigint()`. */
export function secondsSince(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e9;
}
