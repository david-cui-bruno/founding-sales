import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetFailures, documentBudgets, lineCount, measureCode, wordCount } from './checkWorkflowBudget.mjs';

const documents = Object.fromEntries(Object.keys(documentBudgets).map(path => [path, 'within budget']));
const counts = { filesOver800: 2, filesOver2000: 1, functionsOver500: 3 };

test('physical line and whitespace-word counting has no trailing phantom line', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('one\r\ntwo\r\n'), 2);
  assert.equal(lineCount('one\ntwo'), 2);
  assert.equal(wordCount('  one\n two\tthree '), 3);
});

test('file thresholds are strictly over, include source languages and exclude documentation/data', () => {
  const result = measureCode([
    { path: 'boundary.ts', text: '\n'.repeat(800) },
    { path: 'large.py', text: '\n'.repeat(801) },
    { path: 'boundary.sql', text: '\n'.repeat(2000) },
    { path: 'huge.sh', text: '\n'.repeat(2001) },
    { path: 'history.md', text: '\n'.repeat(3000) },
    { path: 'package-lock.json', text: '\n'.repeat(3000) },
  ]);
  assert.deepEqual(result.counts, { filesOver800: 3, filesOver2000: 1, functionsOver500: 0 });
});

test('AST handles declarations, arrows, expressions, methods, constructors and accessors without comment false positives', () => {
  const body = '\n' + 'void 0;\n'.repeat(499);
  const forms = [
    `function named() {${body}}`,
    `const arrow = () => {${body}};`,
    `const expression = function () {${body}};`,
    `class C { method() {${body}} }`,
    `class C { constructor() {${body}} }`,
    `class C { get value() {${body}return 1;} }`,
    `class C { set value(v) {${body}} }`,
  ];
  for (const text of forms) assert.equal(measureCode([{ path: 'fixture.tsx', text }]).counts.functionsOver500, 1);
  assert.equal(measureCode([{ path: 'fixture.ts', text: `/*${body}*/\nfunction tiny() {}` }]).counts.functionsOver500, 0);
  assert.equal(measureCode([{ path: 'fixture.ts', text: `function atLimit() {\n${'void 0;\n'.repeat(498)}}` }]).counts.functionsOver500, 0);
});

test('every document budget fails at one word over and accepts its boundary', () => {
  for (const [path, maximum] of Object.entries(documentBudgets)) {
    assert.deepEqual(budgetFailures({ ...documents, [path]: 'word '.repeat(maximum) }, counts, counts), []);
    assert.ok(budgetFailures({ ...documents, [path]: 'word '.repeat(maximum + 1) }, counts, counts).some(message => message.includes(path)));
    assert.ok(budgetFailures({ ...documents, [path]: undefined }, counts, counts).some(message => message.includes('Missing')));
  }
});

test('ratchet rejects increases, invalid ceilings and baseline inflation; reductions must be locked in', () => {
  assert.deepEqual(budgetFailures(documents, counts, counts), []);
  for (const key of Object.keys(counts)) {
    assert.ok(budgetFailures(documents, { ...counts, [key]: counts[key] + 1 }, counts).some(message => message.includes('exceeds')));
    assert.ok(budgetFailures(documents, { ...counts, [key]: counts[key] - 1 }, counts).some(message => message.includes('lower baseline')));
    assert.ok(budgetFailures(documents, counts, { ...counts, [key]: counts[key] + 1 }, counts).some(message => message.includes('cannot increase')));
    assert.ok(budgetFailures(documents, counts, { ...counts, [key]: null }).some(message => message.includes('Invalid')));
  }
});
