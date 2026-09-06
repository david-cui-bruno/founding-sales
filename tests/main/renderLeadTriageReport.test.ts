import { spawnSync } from 'node:child_process';
import {
  existsSync, linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const script = join(root, 'scripts/renderLeadTriageReport.mts');
const scratch: string[] = [];
function temporaryDirectory() {
  const directory = mkdtempSync(join(process.env.JCODE_SCRATCH_DIR ?? tmpdir(), 'lead-task7-'));
  scratch.push(directory);
  return directory;
}
afterEach(() => { for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function node(args: string[], cwd = temporaryDirectory()) {
  expect(process.versions.node.split('.')[0]).toBe('24');
  return spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: '' },
  });
}

it('loads the frozen shared schema through a genuine native Node24 .mts entry without a loader', () => {
  const directory = temporaryDirectory();
  const probe = join(directory, 'native.mts');
  const contract = pathToFileURL(join(root, 'src/shared/contracts/leadTriageReportContract.ts')).href;
  writeFileSync(probe, `import { triageRecommendationSchema } from ${JSON.stringify(contract)};\nconsole.log(triageRecommendationSchema.options.length, import.meta.main);\n`, { mode: 0o600 });
  const result = node([probe], directory);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('6 true\n');
});

import type { LeadTriageSnapshot, LeadTriageAssessment, LeadTriageEvidence } from '../../src/shared/contracts/leadTriageReportContract';
import { assertTriageArtifactSafe, triageEvidenceCodeSchema } from '../../src/shared/contracts/leadTriageReportContract';

type Input = { snapshot: LeadTriageSnapshot; assessments: LeadTriageAssessment[] };
function fixture(count = 1): Input {
  const leads: LeadTriageEvidence[] = Array.from({ length: count }, (_, index): LeadTriageEvidence => ({
    rank: index + 1, queueIndex: index, personId: `p${index + 1}`, salesCycleId: `c${index + 1}`,
    personName: index === 0 ? 'Ada' : `Synthetic ${index + 1}`,
    locality: null, region: null, postalCode: null,
    organization: { label: null, relationship: null, evidenceCodes: [] },
    fit: { points: null, band: null, evidenceCodes: [] },
    timing: { value: null, band: null, triggers: [] },
    cloud: { fit: null, timing: null, contributions: [] },
    reachability: null, dataConfidence: null,
    contacts: { phoneCount: 0, emailCount: 0, usableDirectCount: 0, maskedPrimaryPhone: null, evidenceCodes: [] },
    compliance: { status: 'unknown', refusalReasonCodes: [] }, identityConcernCodes: [],
  }));
  return {
    snapshot: { generatedAt: '2026-09-06T18:00:00.000Z', requestedLimit: 30, scannedQueueRows: count,
      leads, revisionBefore: 9, revisionAfter: 9, privacyScanPassed: true },
    assessments: leads.map(({ personId, salesCycleId, rank }): LeadTriageAssessment => ({
      personId, salesCycleId, recommendation: 'watch', likelyPriority: null,
      evidenceCodes: ['fit_evidence_missing'], suggestedReviewOrder: rank,
    })),
  };
}
async function build(input: Input): Promise<string> {
  const { buildLeadTriageReport } = await import('../../scripts/renderLeadTriageReport.mts');
  return buildLeadTriageReport(input);
}
const emptyReport = `# Top 30 Unreviewed Lead Triage

Generated: \`2026-09-06T18:00:00.000Z\`
Queue ordering: standard application triage ordering
State changes: none
Snapshot revision: \`9\` → \`9\`
Distinct people: \`0\`
Queue rows scanned: \`0\`

## Recommendations

| Rank | Lead | Fit | Timing | Reachability | Confidence | Compliance | Recommendation | Evidence codes |
|---|---|---|---|---|---|---|---|---|

## Counts by recommendation

- Ready candidate: 0
- Needs identity: 0
- Needs compliance: 0
- Needs contact: 0
- Watch: 0
- Dismiss candidate: 0

## Likely P0 candidates

- None reported.

## Likely P1 candidates

- None reported.

## Blocked by compliance

- None reported.

## Needs identity repair

- None reported.

## Suggested founder review order

- None reported.
`;

it('renders the exact approved template for an empty exhausted queue', async () => {
  expect(await build(fixture(0))).toBe(emptyReport);
});

it('renders unknown projections without substituting zero, cloud scores or clear compliance', async () => {
  const input = fixture();
  input.snapshot.leads[0].cloud.fit = 30;
  input.snapshot.leads[0].cloud.timing = 40;
  const report = await build(input);
  expect(report).toContain('| 1 | Ada (person: p1, cycle: c1) | Unknown Unknown/30 | Unknown Unknown/40 | Unknown | Unknown/10 | Unknown | watch |');
  expect(report).toContain('Cloud Fit: 30; Cloud Timing: 40');
  expect(report).toContain('Primary candidate: Unknown');
  expect(report).toContain('## Blocked by compliance\n\n- Rank 1: Ada (person: p1, cycle: c1). Unknown. Refusal codes: Unknown');
  expect(report).not.toContain('Verified clear');
});

it('renders separate persisted Fit and whole-point Timing plus dated and closed evidence', async () => {
  const input = fixture();
  const lead = input.snapshot.leads[0];
  lead.locality = 'Testville'; lead.region = 'RI'; lead.postalCode = '02900';
  lead.organization = { label: 'Example Org', relationship: 'property_owner', evidenceCodes: ['organization_property_match'] };
  lead.fit = { points: 24, band: 'high', evidenceCodes: ['fit_high'] };
  lead.timing = { value: 31, band: 'hot', triggers: [{ code: 'permit_activity', observedAt: '2026-09-01T00:00:00Z', expiresAt: null }] };
  lead.cloud = { fit: 18, timing: 4, contributions: [{ signalCode: 'permit', contribution: 4 }] };
  lead.reachability = 'direct'; lead.dataConfidence = 8;
  lead.contacts = { phoneCount: 2, emailCount: 1, usableDirectCount: 1, maskedPrimaryPhone: '••• ••• 0100', evidenceCodes: ['contact_ownership_unverified'] };
  lead.compliance = { status: 'verified_clear', refusalReasonCodes: [] };
  input.assessments[0] = { ...input.assessments[0], recommendation: 'ready_candidate', likelyPriority: 'P0', evidenceCodes: ['fit_high', 'timing_trigger_active', 'compliance_clear'] };
  const report = await build(input);
  const row = report.split('\n').find((line) => line.startsWith('| 1 |'));
  expect(row).toBe('| 1 | Ada (person: p1, cycle: c1) | High 24/30 | Hot 31/40 | Direct | 8/10 | Verified clear | ready_candidate | Assessment: fit_high (High Fit), timing_trigger_active (Active timing trigger), compliance_clear (Compliance verified clear); Locality: Testville RI 02900; Organization: Example Org, relationship: property_owner; Organization evidence: organization_property_match (Organization property match); Fit evidence: fit_high (High Fit); Triggers: permit_activity observed 2026-09-01T00:00:00Z, expires Unknown; Cloud Fit: 18; Cloud Timing: 4; Cloud contributions: permit: 4; Contacts: 2 phones, 1 emails, 1 usable direct; Primary candidate: ••• ••• 0100; Contact evidence: contact_ownership_unverified (Contact ownership unverified); Refusal codes: None reported; Identity: None reported |');
  expect(report).toContain('## Likely P0 candidates\n\n- Rank 1: Ada (person: p1, cycle: c1). Evidence: fit_high (High Fit), timing_trigger_active (Active timing trigger), compliance_clear (Compliance verified clear)');
});

it('counts all six supplied recommendations without acting as a priority engine', async () => {
  const input = fixture(6);
  const recommendations = ['ready_candidate', 'needs_identity', 'needs_compliance', 'needs_contact', 'watch', 'dismiss_candidate'] as const;
  input.assessments.forEach((assessment, index) => { assessment.recommendation = recommendations[index]; });
  input.assessments[0].likelyPriority = 'P0'; // Unknown projections must not cause reinterpretation.
  input.assessments[3].likelyPriority = 'P1';
  input.snapshot.leads[1].identityConcernCodes = ['identity_collision'];
  input.snapshot.leads[2].compliance = { status: 'blocked', refusalReasonCodes: ['federal_dnc_listed'] };
  input.snapshot.leads[3].compliance = { status: 'mixed', refusalReasonCodes: ['tcpa_status_unknown'] };
  const report = await build(input);
  expect(report).toContain('- Ready candidate: 1\n- Needs identity: 1\n- Needs compliance: 1\n- Needs contact: 1\n- Watch: 1\n- Dismiss candidate: 1');
  expect(report).toContain('## Likely P1 candidates\n\n- Rank 4: Synthetic 4 (person: p4, cycle: c4). Evidence: fit_evidence_missing (Fit evidence missing)');
  expect(report).toContain('- Rank 3: Synthetic 3 (person: p3, cycle: c3). Blocked. Refusal codes: federal_dnc_listed');
  expect(report).toContain('- Rank 4: Synthetic 4 (person: p4, cycle: c4). Mixed. Refusal codes: tcpa_status_unknown');
  expect(report).toContain('## Needs identity repair\n\n- Rank 2: Synthetic 2 (person: p2, cycle: c2). Identity: identity_collision (Identity collision)');
});

it('preserves snapshot rank while independently sorting founder order with rank ties, without mutation', async () => {
  const input = fixture(3);
  input.snapshot.leads[1].queueIndex = 2; input.snapshot.leads[2].queueIndex = 4; input.snapshot.scannedQueueRows = 6;
  input.assessments[0].suggestedReviewOrder = 3;
  input.assessments[1].suggestedReviewOrder = 1;
  input.assessments[2].suggestedReviewOrder = 1;
  input.assessments.reverse();
  const before = JSON.stringify(input);
  const report = await build(input);
  expect(report.split('\n').filter((line) => /^\| \d/.test(line)).map((line) => line.split(' | ')[0])).toEqual(['| 1', '| 2', '| 3']);
  expect(report.split('## Suggested founder review order\n\n')[1]).toBe('1. Rank 2: Synthetic 2 (person: p2, cycle: c2). watch. Evidence: fit_evidence_missing (Fit evidence missing)\n2. Rank 3: Synthetic 3 (person: p3, cycle: c3). watch. Evidence: fit_evidence_missing (Fit evidence missing)\n3. Rank 1: Ada (person: p1, cycle: c1). watch. Evidence: fit_evidence_missing (Fit evidence missing)\n');
  expect(await build(input)).toBe(report);
  expect(JSON.stringify(input)).toBe(before);
});

it.each([0, 7, 8, 19, 20, 40])('displays supplied Timing %i points and keeps its supplied band', async (value) => {
  const input = fixture();
  input.snapshot.leads[0].timing = { value, band: 'warm', triggers: [] };
  expect(await build(input)).toContain(`| Warm ${value}/40 |`);
});

const invalidInputs: [string, (input: Input) => void][] = [
  ['missing assessment', (x) => { x.assessments = []; }],
  ['extra assessment', (x) => { x.assessments.push({ ...x.assessments[0], personId: 'extra', salesCycleId: 'extra' }); }],
  ['duplicate assessment', (x) => { x.assessments.push({ ...x.assessments[0] }); }],
  ['mismatched cycle', (x) => { x.assessments[0].salesCycleId = 'different'; }],
  ['unknown recommendation', (x) => { Object.assign(x.assessments[0], { recommendation: 'call_now' }); }],
  ['multiple recommendations', (x) => { Object.assign(x.assessments[0], { recommendations: ['watch'] }); }],
  ['unknown assessment evidence', (x) => { Object.assign(x.assessments[0], { evidenceCodes: ['provider_says_ready'] }); }],
  ['empty assessment evidence', (x) => { x.assessments[0].evidenceCodes = []; }],
  ['missing privacy flag', (x) => { Reflect.deleteProperty(x.snapshot, 'privacyScanPassed'); }],
  ['false privacy flag', (x) => { Object.assign(x.snapshot, { privacyScanPassed: false }); }],
  ['revision mismatch', (x) => { x.snapshot.revisionAfter++; }],
  ['unknown snapshot field', (x) => { Object.assign(x.snapshot, { extra: true }); }],
  ['unknown nested field', (x) => { Object.assign(x.snapshot.leads[0].fit, { explanation: 'vendor narrative' }); }],
  ['unknown snapshot code', (x) => { Object.assign(x.snapshot.leads[0].organization, { evidenceCodes: ['vendor_match'] }); }],
  ['unknown trigger', (x) => { Object.assign(x.snapshot.leads[0].timing, { triggers: [{ code: 'vendor_text', observedAt: '2026-09-01T00:00:00Z', expiresAt: null }] }); }],
  ['unknown refusal', (x) => { Object.assign(x.snapshot.leads[0].compliance, { refusalReasonCodes: ['vendor_clear'] }); }],
  ['unknown cloud code', (x) => { Object.assign(x.snapshot.leads[0].cloud, { contributions: [{ signalCode: 'vendor_text', contribution: 1 }] }); }],
  ['nonsequential rank', (x) => { x.snapshot.leads[0].rank = 2; }],
  ['nonzero initial queue index', (x) => { x.snapshot.leads[0].queueIndex = 1; }],
  ['invalid scan count', (x) => { x.snapshot.scannedQueueRows = 0; }],
  ['fractional Timing', (x) => { x.snapshot.leads[0].timing.value = 7.999; }],
  ['negative Timing', (x) => { x.snapshot.leads[0].timing.value = -1; }],
  ['out-of-range Timing', (x) => { x.snapshot.leads[0].timing.value = 41; }],
  ['raw phone label', (x) => { x.snapshot.leads[0].personName = '+1 (401) 555-0100'; }],
  ['email organization label', (x) => { x.snapshot.leads[0].organization.label = 'synthetic@example.test'; }],
  ['street locality label', (x) => { x.snapshot.leads[0].locality = '123 Main Street'; }],
  ['unsafe masked phone', (x) => { x.snapshot.leads[0].contacts.maskedPrimaryPhone = '••• 4015550100'; }],
  ['unsafe nested array text', (x) => { Object.assign(x.assessments[0], { notes: [{ safe: ['synthetic@example.test'] }] }); }],
  ...['phone', 'email', 'streetAddress', 'providerPayload', 'rawPayload', 'messageBody', 'messageSubject'].map((key): [string, (input: Input) => void] => [
    `forbidden nested ${key}`, (x) => { Object.assign(x.snapshot.leads[0].organization, { nested: [{ [key]: 'redacted' }] }); },
  ]),
];
it.each(invalidInputs)('rejects %s with a payload-free error', async (_name, mutate) => {
  const input = fixture(); mutate(input);
  await expect(build(input)).rejects.toThrow(/^Invalid triage report input\.$/);
});

it('scans final Markdown when separately safe raw locality fields compose a street address', async () => {
  const input = fixture();
  input.snapshot.leads[0].locality = '123'; input.snapshot.leads[0].region = 'Main'; input.snapshot.leads[0].postalCode = 'Street';
  expect(() => assertTriageArtifactSafe(input)).not.toThrow();
  await expect(build(input)).rejects.toThrow(/^Invalid triage report input\.$/);
});

it('escapes untrusted Markdown, HTML entities, links and control characters in every display occurrence', async () => {
  const input = fixture();
  const malicious = 'A|B\n# go\r\t[click](https://example.test) ![img](x) `run` <b>&#64;</b>\u202e';
  input.snapshot.leads[0].personName = malicious;
  input.snapshot.leads[0].organization.label = malicious;
  const report = await build(input);
  expect(report).toContain('A&#124;B \\# go');
  expect(report).not.toMatch(/\n# go|\[click\]\(|!\[img\]|<b>|&#64;|\u202e/);
  expect(report).toContain('\\[click\\]\\(https&#58;//example\\.test\\)');
  expect(report.split('\n').filter((line) => line.startsWith('| 1 |'))).toHaveLength(1);
  expect(report.split('\n').find((line) => line.startsWith('| 1 |'))?.split('|')).toHaveLength(11);
});

it('has a reviewed label for every accepted evidence code rather than synthesizing unknown narratives', async () => {
  const input = fixture(); input.assessments[0].evidenceCodes = [...triageEvidenceCodeSchema.options];
  const report = await build(input);
  for (const code of triageEvidenceCodeSchema.options) expect(report).toMatch(new RegExp(`${code} \\([A-Z][^)]*\\)`));
  expect(report).toContain('enrichment_rate_limited (Enrichment rate limited)');
});

function cliFiles(input = fixture()) {
  const directory = temporaryDirectory();
  const snapshot = join(directory, 'snapshot.json');
  const assessments = join(directory, 'assessments.json');
  const output = join(directory, 'report.md');
  writeFileSync(snapshot, JSON.stringify(input.snapshot), { mode: 0o600 });
  writeFileSync(assessments, JSON.stringify(input.assessments), { mode: 0o600 });
  return { directory, snapshot, assessments, output, args: ['--snapshot', snapshot, '--assessments', assessments, '--output', output] };
}
function expectRefusal(result: ReturnType<typeof node>) {
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Unable to render triage report.\n');
  expect(result.stderr).not.toMatch(/SyntaxError|ZodError|ENOENT|EEXIST|EACCES|node:internal|synthetic@example|401.?555|123 Main Street/);
}
// Observer only, not a module-resolution/transpilation hook. It also prevents a
// broken implementation from creating a test report inside the repository.
function observeOutputOpens(directory: string) {
  const observer = join(directory, 'observe.cjs');
  writeFileSync(observer, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.openSync;
fs.openSync = function(path, flags, ...rest) {
  if (typeof flags === 'number' ? !!(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) : /[wa+]/.test(flags)) {
    process.stdout.write('OUTPUT_OPENED\\n');
    throw new Error('Observed output open');
  }
  return original.call(this, path, flags, ...rest);
};
syncBuiltinESMExports();
`, { mode: 0o600 });
  return ['--require', observer];
}

it('runs the actual Node24 CLI with explicit JSONs, stable bytes, no input mutation and private output', async () => {
  const input = fixture(2);
  const files = cliFiles(input);
  const before = [readFileSync(files.snapshot), readFileSync(files.assessments)];
  // A malformed decoy is not an input and must not be discovered.
  writeFileSync(join(files.directory, 'decoy.json'), 'not JSON', { mode: 0o600 });
  const result = node([script, ...files.args], files.directory);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
  expect(existsSync(files.output)).toBe(true);
  expect(readFileSync(files.output, 'utf8')).toBe(await build(input));
  expect(statSync(files.output).mode & 0o777).toBe(0o600);
  expect(statSync(files.directory).mode & 0o777).toBe(0o700);
  expect([readFileSync(files.snapshot), readFileSync(files.assessments)]).toEqual(before);
  const second = join(files.directory, 'second.md');
  const again = node([script, '--output', second, '--assessments', files.assessments, '--snapshot', files.snapshot], files.directory);
  expect(again.status, again.stderr).toBe(0);
  expect(readFileSync(second)).toEqual(readFileSync(files.output));
  expect(readdirSync(files.directory).sort()).toEqual(['assessments.json', 'decoy.json', 'report.md', 'second.md', 'snapshot.json']);
});

it('supports relative named paths from an unrelated private working directory', () => {
  const files = cliFiles(fixture(0));
  const result = node([script, '--snapshot', 'snapshot.json', '--assessments', 'assessments.json', '--output', 'report.md'], files.directory);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(files.output)).toBe(true);
  expect(readFileSync(files.output, 'utf8')).toBe(emptyReport);
});

it('imports and builds under Node permissions without data access, writes, subprocesses or addons even with CLI-shaped argv', () => {
  const directory = temporaryDirectory();
  const output = join(directory, 'must-not-exist.md');
  const allowed = [script, join(root, 'src/shared/contracts'), join(root, 'package.json'), realpathSync(join(root, 'node_modules/zod'))];
  const result = node(['--permission', ...allowed.map((path) => `--allow-fs-read=${path}`), '--input-type=module', '-e',
    `import assert from 'node:assert/strict';
const { buildLeadTriageReport } = await import(${JSON.stringify(pathToFileURL(script).href)});
assert.equal(buildLeadTriageReport(${JSON.stringify(fixture(0))}), ${JSON.stringify(emptyReport)});
assert.ok(buildLeadTriageReport(${JSON.stringify(fixture(2))}).includes('| 1 | Ada (person: p1, cycle: c1) |'));
`, '--', '--snapshot', 'forbidden.json', '--assessments', 'forbidden.json', '--output', output], directory);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('');
  expect(existsSync(output)).toBe(false);
  expect(readdirSync(directory)).toEqual([]);
});

it.each([
  { name: 'missing all', args: [] },
  { name: 'missing value', args: ['--snapshot'] },
  { name: 'unknown flag', args: ['--snapshot', 's', '--assessments', 'a', '--output', 'o', '--force'] },
  { name: 'duplicate flag', args: ['--snapshot', 's', '--snapshot', 'a', '--output', 'o'] },
  { name: 'positional', args: ['s', 'a', 'o'] },
  { name: 'option as value', args: ['--snapshot', '--assessments', 'a', '--output', 'o', 'x'] },
  { name: 'empty value', args: ['--snapshot', '', '--assessments', 'a', '--output', 'o'] },
  { name: 'equals syntax', args: ['--snapshot=s', '--assessments=a', '--output=o'] },
])('rejects CLI $name options without opening output', ({ args }) => {
  const directory = temporaryDirectory();
  expectRefusal(node([...observeOutputOpens(directory), script, ...args], directory));
  expect(readdirSync(directory)).toEqual(['observe.cjs']);
});

it.each(invalidInputs)('actual CLI rejects %s before any output open', (_name, mutate) => {
  const input = fixture(); mutate(input);
  const files = cliFiles(input);
  const result = node([...observeOutputOpens(files.directory), script, ...files.args], files.directory);
  expectRefusal(result);
  expect(existsSync(files.output)).toBe(false);
});

it('actual CLI rejects unsafe final composed Markdown before opening output', () => {
  const input = fixture();
  Object.assign(input.snapshot.leads[0], { locality: '123', region: 'Main', postalCode: 'Street' });
  expect(() => assertTriageArtifactSafe(input)).not.toThrow();
  const files = cliFiles(input);
  expectRefusal(node([...observeOutputOpens(files.directory), script, ...files.args], files.directory));
  expect(existsSync(files.output)).toBe(false);
});

it('the native output-open observer detects a valid attempt rather than hiding validation failures', () => {
  const files = cliFiles();
  const result = node([...observeOutputOpens(files.directory), script, ...files.args], files.directory);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('OUTPUT_OPENED\n');
  expect(existsSync(files.output)).toBe(false);
});

it.each(['snapshot', 'assessments'] as const)('refuses malformed %s JSON without leaking parse errors or opening output', (field) => {
  const files = cliFiles();
  writeFileSync(files[field], '{"synthetic@example.test": broken');
  expectRefusal(node([...observeOutputOpens(files.directory), script, ...files.args], files.directory));
  expect(existsSync(files.output)).toBe(false);
});

it('refuses missing inputs without leaking native filesystem paths', () => {
  const files = cliFiles();
  rmSync(files.snapshot);
  const result = node([script, ...files.args], files.directory);
  expectRefusal(result);
  expect(result.stderr).not.toContain(files.snapshot);
  expect(existsSync(files.output)).toBe(false);
});

it('refuses existing destinations byte-for-byte rather than overwriting or changing mode', () => {
  const files = cliFiles();
  writeFileSync(files.output, 'KEEP EXACTLY', { mode: 0o640 });
  const before = statSync(files.output);
  expectRefusal(node([script, ...files.args], files.directory));
  expect(readFileSync(files.output, 'utf8')).toBe('KEEP EXACTLY');
  expect(statSync(files.output).mode).toBe(before.mode);
  expect(statSync(files.output).ino).toBe(before.ino);
});

it.each(['snapshot', 'assessments'] as const)('refuses an output collision with the %s input', (field) => {
  const files = cliFiles();
  const before = readFileSync(files[field]);
  files.args[5] = files[field];
  expectRefusal(node([script, ...files.args], files.directory));
  expect(readFileSync(files[field])).toEqual(before);
});

it.each(['existing', 'dangling', 'input', 'directory'] as const)('refuses a final output symlink to %s without following or replacing it', (kind) => {
  const files = cliFiles();
  const target = kind === 'input' ? files.snapshot : kind === 'directory' ? files.directory : join(files.directory, 'target');
  if (kind === 'existing') writeFileSync(target, 'KEEP', { mode: 0o600 });
  symlinkSync(target, files.output);
  const before = kind === 'input' || kind === 'existing' ? readFileSync(target) : null;
  expectRefusal(node([script, ...files.args], files.directory));
  expect(lstatSync(files.output).isSymbolicLink()).toBe(true);
  expect(readlinkSync(files.output)).toBe(target);
  if (before) expect(readFileSync(target)).toEqual(before);
  if (kind === 'dangling') expect(existsSync(target)).toBe(false);
});

it('refuses a hardlinked existing destination without changing the input inode', () => {
  const files = cliFiles();
  linkSync(files.snapshot, files.output);
  const before = readFileSync(files.snapshot);
  expectRefusal(node([script, ...files.args], files.directory));
  expect(readFileSync(files.snapshot)).toEqual(before);
  expect(statSync(files.output).ino).toBe(statSync(files.snapshot).ino);
});

it('does not create missing output parent directories', () => {
  const files = cliFiles();
  const parent = join(files.directory, 'not-created', 'nested');
  files.args[5] = join(parent, 'report.md');
  expectRefusal(node([script, ...files.args], files.directory));
  expect(existsSync(join(files.directory, 'not-created'))).toBe(false);
});

it.each(['direct', 'symlink-parent', 'dotdot', 'hosting-repository'] as const)('refuses a %s repository destination before any open', (kind) => {
  const files = cliFiles();
  const alias = join(files.directory, 'alias');
  symlinkSync(root, alias);
  const repository = kind === 'hosting-repository' ? root.split('/.worktrees/')[0] : root;
  const target = join(repository, 'task7-must-not-create.md');
  const output = kind === 'symlink-parent' ? join(alias, 'task7-must-not-create.md')
    : kind === 'dotdot' ? join(root, 'scripts', '..', 'task7-must-not-create.md') : target;
  files.args[5] = output;
  expectRefusal(node([...observeOutputOpens(files.directory), script, ...files.args], files.directory));
  expect(existsSync(target)).toBe(false);
});

it('resolves an external symlink parent to its external canonical directory', () => {
  const files = cliFiles();
  const target = temporaryDirectory();
  const alias = join(files.directory, 'outside'); symlinkSync(target, alias);
  files.args[5] = join(alias, 'report.md');
  const result = node([script, ...files.args], files.directory);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(target, 'report.md'))).toBe(true);
  expect(readFileSync(join(target, 'report.md'), 'utf8')).toContain('# Top 30 Unreviewed Lead Triage');
  expect(statSync(join(target, 'report.md')).mode & 0o777).toBe(0o600);
});

it.each(['file', 'symlink'] as const)('exclusively refuses a %s appearing after preflight, preserving its target bytes', (kind) => {
  const files = cliFiles();
  const observer = join(files.directory, 'collision.cjs');
  const before = readFileSync(files.snapshot);
  writeFileSync(observer, `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.openSync;
fs.openSync = function(path, flags, ...rest) {
  if (String(path) === ${JSON.stringify(files.output)}) {
    ${kind === 'symlink' ? `fs.symlinkSync(${JSON.stringify(files.snapshot)}, path);` : `const fd = original(path, 'wx', 0o600); fs.writeFileSync(fd, 'CONCURRENT SENTINEL'); fs.closeSync(fd);`}
  }
  return original.call(this, path, flags, ...rest);
};
syncBuiltinESMExports();
`, { mode: 0o600 });
  expectRefusal(node(['--require', observer, script, ...files.args], files.directory));
  expect(readFileSync(files.snapshot)).toEqual(before);
  if (kind === 'file') expect(readFileSync(files.output, 'utf8')).toBe('CONCURRENT SENTINEL');
  else expect(readlinkSync(files.output)).toBe(files.snapshot);
});

it('creates exactly mode0600 even under a restrictive inherited umask', () => {
  const files = cliFiles();
  const preload = join(files.directory, 'umask.cjs');
  writeFileSync(preload, 'process.umask(0o777);', { mode: 0o600 });
  const result = node(['--require', preload, script, ...files.args], files.directory);
  expect(result.status, result.stderr).toBe(0);
  expect(statSync(files.output).mode & 0o777).toBe(0o600);
});

it('matches composite identities without delimiter collisions and escapes their displayed IDs', async () => {
  const input = fixture(2);
  input.snapshot.leads[0].personId = 'a'; input.snapshot.leads[0].salesCycleId = 'b|c';
  input.snapshot.leads[1].personId = 'a|b'; input.snapshot.leads[1].salesCycleId = 'c';
  input.assessments[0] = { ...input.assessments[0], personId: 'a', salesCycleId: 'b|c', recommendation: 'watch' };
  input.assessments[1] = { ...input.assessments[1], personId: 'a|b', salesCycleId: 'c', recommendation: 'needs_identity' };
  input.assessments.reverse();
  const report = await build(input);
  expect(report).toContain('| 1 | Ada (person: a, cycle: b&#124;c)');
  expect(report).toContain('| 2 | Synthetic 2 (person: a&#124;b, cycle: c)');
  expect(report.split('\n').find((line) => line.startsWith('| 1 |'))).toContain(' | watch | ');
  expect(report.split('\n').find((line) => line.startsWith('| 2 |'))).toContain(' | needs_identity | ');
});

it.each(['personId', 'salesCycleId'] as const)('rejects duplicate snapshot %s identities rather than joining them', async (field) => {
  const input = fixture(2);
  input.snapshot.leads[1][field] = input.snapshot.leads[0][field];
  input.assessments[1][field] = input.assessments[0][field];
  await expect(build(input)).rejects.toThrow(/^Invalid triage report input\.$/);
});

it('rejects raw unsafe strings that Markdown escaping would otherwise disguise', async () => {
  const input = fixture();
  input.snapshot.leads[0].personName = '(401) 555-0100';
  await expect(build(input)).rejects.toThrow(/^Invalid triage report input\.$/);
});

it('rejects cyclic raw input without exposing a recursion or schema exception', async () => {
  const input = fixture();
  Object.assign(input.snapshot.leads[0].organization, { nested: input });
  await expect(build(input)).rejects.toThrow(/^Invalid triage report input\.$/);
});

it('keeps a supplied unknown identity recommendation visible when concern codes are absent', async () => {
  const input = fixture(); input.assessments[0].recommendation = 'needs_identity';
  expect(await build(input)).toContain('## Needs identity repair\n\n- Rank 1: Ada (person: p1, cycle: c1). Identity: Unknown');
});

it('renders the template generation timestamp in UTC even when the accepted snapshot has an offset', async () => {
  const input = fixture(0); input.snapshot.generatedAt = '2026-09-06T14:00:00-04:00';
  expect(await build(input)).toBe(emptyReport);
});

it('renders all thirty permitted leads without losing ranks or recommendation counts', async () => {
  const report = await build(fixture(30));
  expect(report).toContain('Distinct people: `30`\nQueue rows scanned: `30`');
  expect(report).toContain('| 30 | Synthetic 30 (person: p30, cycle: c30)');
  expect(report).toContain('- Watch: 30');
  expect(report.split('\n').filter((line) => /^\| \d/.test(line))).toHaveLength(30);
});

it.each(['Main-River', 'Main.River'])('rejects composed %s street text before Markdown escaping can disguise it', async (region) => {
  const input = fixture();
  Object.assign(input.snapshot.leads[0], { locality: '123', region, postalCode: 'Street' });
  expect(() => assertTriageArtifactSafe(input)).not.toThrow();
  expect(() => assertTriageArtifactSafe(`123 ${region} Street`)).toThrow(/^Unsafe triage artifact\.$/);
  await expect(build(input)).rejects.toThrow(/^Invalid triage report input\.$/);
});

it.each(['Main-River', 'Main.River'])('native CLI rejects composed %s street text with zero output opens', (region) => {
  const input = fixture();
  Object.assign(input.snapshot.leads[0], { locality: '123', region, postalCode: 'Street' });
  expect(() => assertTriageArtifactSafe(input)).not.toThrow();
  expect(() => assertTriageArtifactSafe(`123 ${region} Street`)).toThrow(/^Unsafe triage artifact\.$/);
  const files = cliFiles(input);
  const result = node([...observeOutputOpens(files.directory), script, ...files.args], files.directory);
  expectRefusal(result);
  expect(result.stderr).not.toContain(region);
  expect(existsSync(files.output)).toBe(false);
});

function safeHyphenFixture(): Input {
  const input = fixture();
  Object.assign(input.snapshot.leads[0], { personName: 'Ada-River', locality: 'North-River', region: 'RI', postalCode: '02900' });
  input.snapshot.leads[0].organization.label = 'Main-River';
  return input;
}

it('accepts safe hyphenated display text while retaining Markdown escaping', async () => {
  const report = await build(safeHyphenFixture());
  expect(report).toContain('Ada\\-River (person: p1, cycle: c1)');
  expect(report).toContain('Locality: North\\-River RI 02900; Organization: Main\\-River, relationship: Unknown');
});

it('native CLI accepts safe hyphenated display text and writes private escaped Markdown', async () => {
  const input = safeHyphenFixture();
  const files = cliFiles(input);
  const result = node([script, ...files.args], files.directory);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(files.output)).toBe(true);
  expect(readFileSync(files.output, 'utf8')).toBe(await build(input));
  expect(readFileSync(files.output, 'utf8')).toContain('Locality: North\\-River RI 02900;');
  expect(statSync(files.output).mode & 0o777).toBe(0o600);
});
