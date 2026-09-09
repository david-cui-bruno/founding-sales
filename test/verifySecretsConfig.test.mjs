import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const config = readFileSync(new URL('../.gitleaks.toml', import.meta.url), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const marker = '# Independently classified';
const selfMarker = '# Exact pinned public detector definition';
const inventoryMarker = '# Exact public preload API inventory';

it('pins every default 8.30.1 detector and rule-specific allowance byte-for-byte', () => {
  expect(config).not.toMatch(/^\[extend\]/m);
  const rules = config.slice(config.indexOf('[[rules]]'), config.indexOf(marker));
  expect(rules.match(/^\[\[rules\]\]/gm)).toHaveLength(222);
  expect(sha256(rules)).toBe('def33a7a1b1270525f23e6672f85f795535c2558b86e750f0abe1ddd48979db0');
});

it('removes only upstream global path allowances while preserving regexes and stopwords', () => {
  const global = config.slice(config.indexOf('title = "gitleaks config"'), config.indexOf('[[rules]]'));
  expect(global).not.toMatch(/^paths\s*=/m);
  expect(sha256(global)).toBe('c683f2895dd81d6af3fb6562627049fa8a71127dcb320ab0766fe4c49650e6c7');
});

it('retains the independently approved full-span exception exactly', () => {
  expect(sha256(config.split(marker)[1].split(selfMarker)[0])).toBe('b8cf8e2a6424c417f7e93e85dbc54c3ae6dfb238d4a9f48680041d0c9ab94485');
});

it('limits the public-regex disposition to the exact 58-byte definition, path and rule', () => {
  const line = config.match(/id = "aws-amazon-bedrock-api-key-short-lived"\n[^\n]*\n(regex = [^\n]*)/)[1];
  expect(Buffer.byteLength(line)).toBe(58);
  expect(sha256(line)).toBe('3af0e582e69dbfd0c60ca7c75fa05ef69325cb4e125ef7248c46a190732682bb');
  const encoded = [...Buffer.from(line)].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('');
  expect(config.split(selfMarker)[1].split(inventoryMarker)[0]).toBe(`, not a credential or a file waiver.\n[[allowlists]]\ndescription = "Exact pinned public Bedrock detector definition only"\ntargetRules = ["aws-amazon-bedrock-api-key-short-lived"]\ncondition = "AND"\npaths = ['''\\A\\.gitleaks\\.toml\\z''']\nregexTarget = "line"\nregexes = ['''\\A\\n?${encoded}\\z''']\n`);
});

it('limits the public API-name exception to the exact 147-byte inventory, path and rule', () => {
  const line = readFileSync(new URL('../tests/integration/appleSpikePreload.test.ts', import.meta.url), 'utf8').split('\n').find(value => value.includes("'localWorkspace'"));
  expect(Buffer.byteLength(line)).toBe(147);
  expect(sha256(line)).toBe('34f77d763883e912c8f55ad22b3601b5443fa83292859fd6aa6ff2c52dda3282');
  const encoded = [...Buffer.from(line)].map(byte => `\\x${byte.toString(16).padStart(2, '0')}`).join('');
  expect(config.split(inventoryMarker)[1]).toBe(`, not a credential or a file waiver.\n[[allowlists]]\ndescription = "Exact public preload namespace inventory only"\ntargetRules = ["linkedin-client-id"]\ncondition = "AND"\npaths = ['''\\Atests/integration/appleSpikePreload\\.test\\.ts\\z''']\nregexTarget = "line"\nregexes = ['''\\A\\n?${encoded}\\z''']\n`);
});
