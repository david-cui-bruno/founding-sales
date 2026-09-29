/**
 * Enough of PostgreSQL's lexer to split a migration file into top-level statements.
 *
 * The classifier and the privilege check both have to answer questions about the
 * statements a migration file *executes*, and a line-oriented grep answers them wrong
 * in exactly the way that matters: migration 0023 carries an `INSERT INTO
 * today_snapshots` inside the body of a `CREATE OR REPLACE FUNCTION`, which is not an
 * insert the migration performs. So the splitter knows about `--` comments, block
 * comments, single-quoted literals, double-quoted identifiers and dollar quoting, and
 * nothing else; a migration that needs more than that is a migration nobody should
 * have written.
 */

export interface Statement {
  /** The statement's text, comments and all, as it appears in the file. */
  readonly text: string;
  /** The statement with comments and runs of whitespace removed, for matching. */
  readonly normalized: string;
  /** 1-based line number of the statement's first non-comment character. */
  readonly line: number;
}

interface Scan {
  readonly text: string;
  readonly code: string;
  readonly line: number;
}

/** Split `sql` at top-level semicolons, returning the raw and comment-stripped forms. */
function scan(sql: string): readonly Scan[] {
  const out: Scan[] = [];
  let text = '';
  let code = '';
  let line = 1;
  let startLine = 1;
  let started = false;
  let index = 0;

  const push = (): void => {
    if (code.trim().length > 0) out.push({ text: text.trim(), code: code.replace(/\s+/gu, ' ').trim(), line: startLine });
    text = '';
    code = '';
    started = false;
  };

  while (index < sql.length) {
    const rest = sql.slice(index);
    const character = sql[index] ?? '';
    const isCode = !rest.startsWith('--') && !rest.startsWith('/*') && character.trim().length > 0;
    if (isCode && !started) {
      started = true;
      startLine = line;
    }

    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      text += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (rest.startsWith('/*')) {
      // Block comments nest in PostgreSQL.
      let depth = 0;
      const from = index;
      while (index < sql.length) {
        if (sql.startsWith('/*', index)) { depth += 1; index += 2; continue; }
        if (sql.startsWith('*/', index)) { depth -= 1; index += 2; if (depth === 0) break; continue; }
        if (sql[index] === '\n') line += 1;
        index += 1;
      }
      text += sql.slice(from, index);
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      const from = index;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { index += 2; continue; }
          index += 1;
          break;
        }
        if (sql[index] === '\n') line += 1;
        index += 1;
      }
      const chunk = sql.slice(from, index);
      text += chunk;
      code += chunk;
      continue;
    }
    const dollar = /^\$[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*\$|^\$\$/u.exec(rest);
    if (dollar !== null) {
      const tag = dollar[0];
      const from = index;
      index += tag.length;
      const close = sql.indexOf(tag, index);
      index = close === -1 ? sql.length : close + tag.length;
      const chunk = sql.slice(from, index);
      line += (chunk.match(/\n/gu) ?? []).length;
      text += chunk;
      code += chunk;
      continue;
    }
    if (character === ';') {
      text += ';';
      code += ';';
      push();
      index += 1;
      continue;
    }
    if (character === '\n') line += 1;
    text += character;
    code += character;
    index += 1;
  }
  push();
  return out;
}

export function statementsOf(sql: string): readonly Statement[] {
  return scan(sql).map(entry => ({ text: entry.text, normalized: entry.code, line: entry.line }));
}
