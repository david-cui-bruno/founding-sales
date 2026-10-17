import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const documentBudgets = Object.freeze({
  'AGENTS.md': 400,
  'docs/operations/current-state.md': 800,
  'docs/sourcing/roadmap-20261007.md': 1500,
  '.jcode/skills/fss-review/SKILL.md': 400,
});
// Count tracked source/test code, not prose, dependency data or generated output.
const codeExtension = /\.(?:[cm]?[jt]sx?|py|sh|sql|tf|hcl|css|html)$/u;
const javascriptExtension = /\.[cm]?[jt]sx?$/u;
export const wordCount = text => text.match(/\S+/gu)?.length ?? 0;
export const lineCount = text => text === '' ? 0 : text.split('\n').length - Number(text.endsWith('\n'));

export function measureCode(files) {
  const largeFiles = [], hugeFiles = [], longFunctions = [];
  for (const { path, text } of files) {
    if (!codeExtension.test(path)) continue;
    const lines = lineCount(text);
    if (lines > 800) largeFiles.push({ path, lines });
    if (lines > 2000) hugeFiles.push({ path, lines });
    if (!javascriptExtension.test(path)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    // TypeScript's AST covers declarations, expressions, arrows, methods,
    // constructors and accessors, including nested functions and TSX.
    function visit(node) {
      if (ts.isFunctionLike(node) && node.body) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const end = source.getLineAndCharacterOfPosition(node.end - 1).line;
        if (end - start + 1 > 500) longFunctions.push({ path, line: start + 1, lines: end - start + 1 });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { counts: { filesOver800: largeFiles.length, filesOver2000: hugeFiles.length, functionsOver500: longFunctions.length }, largeFiles, hugeFiles, longFunctions };
}

export function budgetFailures(documents, counts, baseline, previousBaseline = baseline) {
  const failures = [];
  for (const [path, maximum] of Object.entries(documentBudgets)) {
    if (typeof documents[path] !== 'string') failures.push(`Missing budgeted document: ${path}`);
    else if (wordCount(documents[path]) > maximum) failures.push(`${path}: ${wordCount(documents[path])} words exceeds ${maximum}`);
  }
  for (const key of ['filesOver800', 'filesOver2000', 'functionsOver500']) {
    if (!Number.isSafeInteger(baseline[key]) || baseline[key] < 0) failures.push(`Invalid size baseline: ${key}`);
    else if (!Number.isSafeInteger(previousBaseline[key]) || previousBaseline[key] < 0 || baseline[key] > previousBaseline[key]) failures.push(`Size baseline cannot increase: ${key}`);
    else if (counts[key] > baseline[key]) failures.push(`${key}: ${counts[key]} exceeds baseline ${baseline[key]}`);
    else if (counts[key] < baseline[key]) failures.push(`${key}: lower baseline to ${counts[key]} so reductions stay locked in`);
  }
  return failures;
}

export function runGate(root, baseRef) {
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16_000_000 }).split('\0').filter(Boolean);
  const report = measureCode(paths.filter(path => codeExtension.test(path)).map(path => ({ path, text: read(path) })));
  const documents = Object.fromEntries(Object.keys(documentBudgets).map(path => [path, read(path)]));
  const baseline = JSON.parse(read('scripts/code-size-baseline.json'));
  const hasPrevious = baseRef && execFileSync('git', ['ls-tree', '--name-only', baseRef, '--', 'scripts/code-size-baseline.json'], { cwd: root, encoding: 'utf8' }).trim();
  // The first adoption has no base file. Later changes cannot raise its ceiling.
  const previous = hasPrevious ? JSON.parse(execFileSync('git', ['show', `${baseRef}:scripts/code-size-baseline.json`], { cwd: root, encoding: 'utf8' })) : baseline;
  const failures = budgetFailures(documents, report.counts, baseline, previous);
  console.log(JSON.stringify({ words: Object.fromEntries(Object.entries(documents).map(([path, text]) => [path, wordCount(text)])), ...report, failures }, null, 2));
  return failures.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/checkWorkflowBudget.mjs [base-ref]');
    process.exitCode = runGate(resolve(fileURLToPath(new URL('..', import.meta.url))), process.argv[2]);
  } catch (error) {
    console.error(`Workflow budget check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
