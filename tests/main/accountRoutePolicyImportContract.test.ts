import { describe, expect, it } from 'vitest';
import { accountRoutePolicyImportArtifactSchema, policyImportConfirmSchema } from '../../src/shared/contracts/accountRoutePolicyImportContract';

const now = '2026-09-08T14:00:00.000Z';
function artifact() {
  return { format: 'fss-account-route-policy-review', version: 1, workspaceId: '11111111-1111-4111-8111-111111111111',
    documents: [{ id: 'document', mediaType: 'text/plain', content: 'Fictional owner supplied evidence. Not government verification.', sha256: 'a'.repeat(64) }],
    rows: [{ rowId: 'row', accountId: 'account', routeId: 'route', expectedRouteVersion: 1, expectedEvidenceFingerprint: 'b'.repeat(64), targetSourceIds: ['source'], documentIds: ['document'],
      citations: [{ documentId: 'document', field: 'contact.evidence', excerpt: 'Fictional owner supplied evidence.' }], observedAt: now, effectiveAt: now, expiresAt: '2026-09-09T14:00:00.000Z', operation: 'observe', reason: 'Imported documentary evidence for owner review',
      policy: { contact: { kind: 'phone', normalizedValue: '+14015550100', validationState: 'unverified', evidence: { source: 'manual_import', federalStatus: 'unknown', tcpaFlag: null as boolean | null, coveredAreaCode: null as string | null, scrubbedAt: null as string | null, expiresAt: null as string | null } }, jurisdiction: null as null, clearance: null as null } }] };
}
describe('strict FSS owner-reviewed evidence interchange', () => {
  it('accepts explicit unknown manual-import evidence without manufacturing clearance', () => {
    expect(accountRoutePolicyImportArtifactSchema.parse(artifact()).rows[0].policy.contact.evidence.federalStatus).toBe('unknown');
  });
  it.each(['government', 'vendor', 'coverage', 'lifetime', 'permission', 'duplicate', 'citation'] as const)('rejects %s invalid interchange inputs', mode => {
    const value = artifact();
    if (mode === 'government') value.rows[0].policy.contact.evidence.source = 'ftc_download';
    if (mode === 'vendor') value.rows[0].policy.contact.evidence.source = 'enrichment_vendor';
    if (mode === 'coverage') value.rows[0].policy.contact.evidence.federalStatus = 'verified_clear';
    if (mode === 'lifetime') Object.assign(value.rows[0].policy.contact.evidence, { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', scrubbedAt: now, expiresAt: '2026-11-09T14:00:00.000Z' });
    if (mode === 'permission') Object.assign(value, { allowed: true });
    if (mode === 'duplicate') value.rows.push(value.rows[0]);
    if (mode === 'citation') value.rows[0].citations[0].documentId = 'missing';
    expect(accountRoutePolicyImportArtifactSchema.safeParse(value).success).toBe(false);
  });
  it('accepts only preview identity and review reason at the confirmation IPC boundary', () => {
    const confirm = { previewId: 'preview', expectedArtifactHash: 'a'.repeat(64), reviewReason: 'I reviewed the exact evidence shown in the main confirmation.' };
    expect(policyImportConfirmSchema.parse(confirm)).toEqual(confirm);
    expect(policyImportConfirmSchema.safeParse({ ...confirm, approved: true }).success).toBe(false);
    expect(policyImportConfirmSchema.safeParse({ ...confirm, policy: artifact().rows[0].policy }).success).toBe(false);
    expect(policyImportConfirmSchema.safeParse({ ...confirm, filePath: '/fictional/file.json' }).success).toBe(false);
  });
});

it('keeps canonical schemas single-sourced and shared/preload runtime graphs free of node/main effects', async () => {
  const shared = await import('../../src/shared/contracts/accountRoutePolicyContract');
  const store = await import('../../src/main/delegation/accountRoutePolicyStore');
  expect(store.accountRoutePolicySchema).toBe(shared.accountRoutePolicySchema);
  expect(store.routePolicyReceiptSchema).toBe(shared.routePolicyReceiptSchema);
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const ts = await import('typescript');
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      if ((ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) || (ts.isExportDeclaration(node) && node.isTypeOnly)) continue;
      const spec = node.moduleSpecifier;
      if (!spec || !ts.isStringLiteral(spec)) continue;
      expect(spec.text.startsWith('node:')).toBe(false);
      if (!spec.text.startsWith('.')) { expect(['zod', 'electron']).toContain(spec.text); continue; }
      const base = resolve(dirname(file), spec.text);
      const target = [base, `${base}.ts`, `${base}/index.ts`].find(path => path.endsWith('.ts') && existsSync(path));
      expect(target, `${file}: ${spec.text}`).toBeDefined(); visit(target!);
    }
  };
  for (const file of ['src/shared/contracts/accountRoutePolicyContract.ts', 'src/shared/contracts/accountRoutePolicyImportContract.ts', 'src/preload/createCallieApi.ts']) visit(resolve(file));
});
