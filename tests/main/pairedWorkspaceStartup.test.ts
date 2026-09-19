import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../src/main/db/database';
import { createAccountRoutePolicyImport } from '../../src/main/delegation/accountRoutePolicyImport';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import type { StoredPairing } from '../../src/main/delegation/pairingStore';
import { accountIdSchema } from '../../src/shared/contracts/accountContract';
import {
  accountRoutePolicyImportArtifactSchema,
  policyImportResumeSchema,
  policyImportStatusSchema,
} from '../../src/shared/contracts/accountRoutePolicyImportContract';

const slug = 'fss-david-pilot';
const uuid = '11111111-1111-4111-8111-111111111111';
const now = '2026-09-14T03:00:00.000Z';
function pairing(workspaceId: string): StoredPairing {
  return { endpoint: 'https://worker.example.test', workspaceId, pairingId: uuid,
    credential: 'a'.repeat(43), emergencyCredential: 'b'.repeat(43), generation: 0,
    scopes: ['commands:write', 'events:read'] };
}
function artifact(workspaceId: unknown) {
  const content = 'Fictional owner supplied evidence. Not government verification.';
  return { format: 'fss-account-route-policy-review', version: 1, workspaceId,
    documents: [{ id: 'document', mediaType: 'text/plain', content,
      sha256: createHash('sha256').update(content).digest('hex') }],
    rows: [{ rowId: 'row', accountId: 'account', routeId: 'route', expectedRouteVersion: 1,
      expectedEvidenceFingerprint: 'b'.repeat(64), targetSourceIds: ['source'], documentIds: ['document'],
      citations: [{ documentId: 'document', field: 'contact.evidence', excerpt: 'Fictional owner supplied evidence.' }],
      observedAt: now, effectiveAt: now, expiresAt: '2026-09-15T03:00:00.000Z', operation: 'observe',
      reason: 'Imported documentary evidence for owner review',
      policy: { contact: { kind: 'phone', normalizedValue: '+14015550100', validationState: 'unverified',
        evidence: { source: 'manual_import', federalStatus: 'unknown', tcpaFlag: null as null, coveredAreaCode: null as null,
          scrubbedAt: null as null, expiresAt: null as null } }, jurisdiction: null as null, clearance: null as null } }] };
}
function native() {
  return { selectArtifact: vi.fn(async () => null as Uint8Array | null),
    confirmReview: vi.fn(async () => { throw Error('unexpected native confirmation'); }) };
}

describe('paired workspace startup with production policyImportNative wiring (pure)', () => {
  it.each([slug, uuid, 'x', 'x'.repeat(200), ` ${slug} `])('constructs without I/O for canonical workspace %j', async workspaceId => {
    const withDatabase = vi.fn(async () => { throw Error('unexpected database lease'); });
    const fetch = vi.fn(async () => { throw Error('unexpected HTTP'); });
    const policyImportNative = native();
    const runtime = createDelegationRuntime({ databaseGate: { withDatabase }, pairing: pairing(workspaceId),
      clock: { now: () => now }, fetch, policyImportNative });
    try {
      if (workspaceId === uuid) {
        expect(runtime.policyImport).not.toBeNull();
        expect(runtime.policyImport?.selectAndPreview).toBeTypeOf('function');
      } else {
        expect(runtime.policyImport).toBeNull();
      }
      expect(runtime.researchSetup).toBeDefined();
      expect(runtime.googleConnections).toBeDefined();
      expect(runtime.sync).toBeTypeOf('function');
    } finally { await runtime.dispose(); }
    expect(withDatabase).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(policyImportNative.selectArtifact).not.toHaveBeenCalled();
    expect(policyImportNative.confirmReview).not.toHaveBeenCalled();
  });

  it.each(['', 'x'.repeat(201), null, undefined, 123])('keeps invalid canonical workspace %j rejected at importer and artifact boundaries', workspaceId => {
    expect(accountIdSchema.safeParse(workspaceId).success).toBe(false);
    const withDatabase = vi.fn(async () => { throw Error('unexpected database lease'); });
    expect(() => createAccountRoutePolicyImport({ databaseGate: { withDatabase },
      // PairingStore owns pairing validation. The importer retains its strict UUID boundary.
      workspaceId: workspaceId as string, clock: { now: () => now }, native: native() })).toThrow();
    expect(accountRoutePolicyImportArtifactSchema.safeParse(artifact(workspaceId)).success).toBe(false);
    expect(withDatabase).not.toHaveBeenCalled();
  });

  it('retains UUID-only artifact eligibility until a separate storage migration', () => {
    expect(accountRoutePolicyImportArtifactSchema.parse(artifact(uuid)).workspaceId).toBe(uuid);
    for (const workspaceId of [slug, 'x', 'x'.repeat(200), ` ${uuid} `]) {
      expect(accountRoutePolicyImportArtifactSchema.safeParse(artifact(workspaceId)).success).toBe(false);
    }
  });

  it('leaves unpaired native importer inactive without I/O', async () => {
    const withDatabase = vi.fn(async () => { throw Error('unexpected database lease'); });
    const fetch = vi.fn(async () => { throw Error('unexpected HTTP'); });
    const policyImportNative = native();
    const runtime = createDelegationRuntime({ databaseGate: { withDatabase }, pairing: null,
      clock: { now: () => now }, fetch, policyImportNative });
    try { expect(runtime.policyImport).toBeNull(); } finally { await runtime.dispose(); }
    expect(withDatabase).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(policyImportNative.selectArtifact).not.toHaveBeenCalled();
    expect(policyImportNative.confirmReview).not.toHaveBeenCalled();
  });

  it.each([
    [uuid, '22222222-2222-4222-8222-222222222222'],
  ])('refuses foreign artifact %j / %j before any database access or writes', async (workspaceId, foreignWorkspaceId) => {
    const databaseAccess = vi.fn((): never => { throw Error('unexpected database access'); });
    // No native DB is imported or opened. Even reading a property fails closed.
    const database = new Proxy({} as AppDatabase, { get: databaseAccess });
    const databaseLease = vi.fn();
    const withDatabase = async <T>(run: (db: AppDatabase) => T | Promise<T>): Promise<T> => { databaseLease(); return run(database); };
    const policyImportNative = native();
    policyImportNative.selectArtifact.mockResolvedValue(Buffer.from(JSON.stringify(artifact(foreignWorkspaceId))));
    const fetch = vi.fn(async () => { throw Error('unexpected HTTP'); });
    const runtime = createDelegationRuntime({ databaseGate: { withDatabase }, pairing: pairing(workspaceId),
      clock: { now: () => now }, policyImportNative, fetch });
    try {
      await expect(runtime.policyImport!.selectAndPreview()).rejects.toThrow('workspace_mismatch');
      expect(databaseLease).toHaveBeenCalledTimes(1);
      expect(policyImportNative.selectArtifact).toHaveBeenCalledTimes(1);
      expect(databaseAccess).not.toHaveBeenCalled();
      expect(policyImportNative.confirmReview).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });

  it('retains UUID review identities and strict artifact authority boundary', () => {
    expect(policyImportResumeSchema.safeParse({ reviewId: uuid, expectedArtifactHash: 'a'.repeat(64) }).success).toBe(true);
    expect(policyImportStatusSchema.safeParse({ reviewId: uuid }).success).toBe(true);
    expect(policyImportResumeSchema.safeParse({ reviewId: slug, expectedArtifactHash: 'a'.repeat(64) }).success).toBe(false);
    expect(policyImportStatusSchema.safeParse({ reviewId: slug }).success).toBe(false);
    expect(accountRoutePolicyImportArtifactSchema.safeParse({ ...artifact(uuid), allowed: true }).success).toBe(false);
  });
});
