# Lead Review Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present enriched contact candidates as evidence rather than verified contacts, enforce qualification and compliance gates before enrichment or outreach, and expose a strictly read-only top-30 triage snapshot that Jcode can turn into a founder-facing Markdown report without mutating leads.

**Architecture:** Build on the completed outbound-compliance plan and runtime/recovery plan rather than creating a second compliance model. Add only presentation-specific contact metadata in schema 16, carry vendor rank/kind/source and ownership state through intake, consume the compliance projection and final outbound gate introduced by `2026-09-04-outbound-compliance-hardening.md`, and derive deterministic primary/alternative presentation. Extend the existing Today read seam with a read-only triage snapshot endpoint that preserves `getTriageQueue()` ordering, then use a pure report formatter plus a Jcode runbook to produce a masked Markdown report in a private external directory. No blended score, automatic enrichment, automatic recommendation mutation, or bulk action is introduced.

**Tech Stack:** Electron 44, React 19, TypeScript 5.9, Zod 4, better-sqlite3-multiple-ciphers, Kysely migrations, Vitest, Testing Library, Playwright, Electron Forge.

**Spec:** `docs/superpowers/specs/2026-09-04-lead-review-triage-design.md`

## Global Constraints

- This plan follows the approved spec dated 2026-09-04.
- Execute tracked lead-review implementation only after outbound-compliance contracts/final authorization are complete and reviewed, and after either full runtime Task 13 sign-off or completion and independent review of the runtime plan's Schema-15 handoff exception, including its mandatory disposable-fixture handoff verification. Schema 16 must never be opened by schema-15 identity or recovery tooling. The handoff exception authorizes code and fixture verification only; accessing or migrating the founder workspace, capturing a live triage snapshot, or performing any runtime operational action still requires the applicable separate confirmation and hold point.
- Schema ownership is locked across the plan set: compliance uses 0013 and 0014, runtime/recovery uses 0015, and this plan uses 0016. Do not renumber or duplicate the compliance evidence columns.
- Consume `ContactComplianceEvidence`, `phoneComplianceStatusSchema`, and final authorization from the compliance plan. Do not create a second boolean-based compliance evaluator.
- Raw vendor records are always presented as candidates, never as verified ownership.
- Fit and Timing remain separate fields and display regions. Do not add a blended score or sort key.
- Compliance is a hard gate. It may block action but never increase priority.
- Enrichment remains one explicit founder action for one lead. There is no bulk enrichment.
- Unknown, expired, blocked, uncovered, or state-clearance-required phone evidence never enables Call or Text.
- Triage reads only. Snapshot collection and report generation must not call any mutation endpoint or write the application database.
- Triage artifacts live under `~/.local/share/callie/triage/YYYY-MM-DD/` in a mode-0700 directory with mode-0600 files. Never commit a live snapshot, assessment file, or founder report.
- Preserve the existing standard triage order from `FounderSalesDomain.getTriageQueue()`: active, unreviewed, non-opted-out, non-deleted, currently surfaced cycles ordered by `cycle.id COLLATE BINARY`.
- Every `npm` or `npx` command below starts with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`.
- Run migration backup verification before accepting schema 16 in the packaged application.

---

## File Structure and Locked Boundaries

### Contact evidence and eligibility

- Create `src/main/db/migrations/0016ContactPresentationEvidence.ts`: additive schema-16 source, rank, phone-kind, ownership, and evidence-observed columns.
- Create `tests/main/db/migrations/0016ContactPresentationEvidence.test.ts`: isolated 15→16 migration, exact table SQL/ordered column metadata, defaults, constraints, idempotence, and schema-15 recovery-object preservation.
- Modify `src/main/db/migrate.ts`: register `0016ContactPresentationEvidence` after runtime schema 15.
- Modify `src/main/db/domainSchema.ts`: type the new presentation columns without removing compliance or jurisdiction types.
- Modify `src/main/db/plaintextDatabaseUpgrade.ts`: recognize encrypted schema 16 and continue rejecting schema 17 or any future version.
- Modify `src/main/domain/domainRuntime.ts`: require exactly schema 16 before domain composition.
- Modify `src/main/domain/startup/storageReadiness.ts`: lock startup to schema 16, the exact ordered 0001…0016 Kysely ledger, and the exact schema catalog/table/index/trigger SQL.
- Modify `tests/main/migrations.test.ts`: expect schema version 16 and the exact ordered migration ledger while keeping migration-0015 isolated expectations at schema 15.
- Modify `tests/main/healthService.test.ts`: expect the health projection from a latest-migrated database to report schema version 16.
- Modify `tests/main/db/migrations/0009SourcingFileLedger.test.ts`, `tests/main/db/migrations/0011ContactDncFlags.test.ts`, and `tests/main/db/migrations/0012UpstreamRequestState.test.ts`: update every `migrateToLatest` result, ordered applied-migration list, idempotence boundary, and `app_meta` assertion to schema 16 with `0016ContactPresentationEvidence` last.
- Modify `tests/main/db/migrations/0015RecoveryMetadata.test.ts`: replace `migrateToLatest` with an explicit `createMigrationRunner` through `0015RecoveryMetadata` so this isolated historical suite continues to stop at schema 15 after 0016 is registered.
- Modify `tests/main/domainStartupAudit.test.ts`: reject versions 15 and 17, missing/extra/reordered/duplicate ledger rows, schema/ledger mismatches, and catalog/table/index/trigger drift before startup readiness.
- Modify `tests/integration/foundationRecovery.test.ts`: prove schema-15 recovery tables and immutable identity-repair triggers survive 15→16 and restore unchanged.
- Modify `tests/integration/plaintextDatabaseUpgrade.test.ts` and `tests/support/plaintextUpgradeScenario.ts`: add explicit encrypted-schema-16 acceptance and schema-17/future rejection with byte-for-byte immutability on rejection.
- Modify `tests/e2e/foundation.spec.ts` and `tests/support/domainSchemaScenario.ts`: assert packaged/runtime schema 16 plus the exact catalog and contact-table contract.
- Modify `tests/integration/migrationBackup.test.ts` and `tests/support/migrationBackupScenario.ts`: add the current-pattern aggregate backup/restore scenario proving schema-15 recovery tables, rows, indexes, and both immutable identity-repair triggers survive the 15→16 backup boundary byte-for-byte.
- Do not blanket-rewrite historical operational receipt fixtures whose `schemaVersion: 15` records evidence. Change such a row only when the fixture explicitly models “latest schema.”
- Consume the nested compliance contract already implemented by the outbound-compliance plan. Do not change its field names or add parallel scrub/state columns.
- Modify `src/main/sourcing/intakeMapper.ts`: carry vendor rank, phone kind, vendor source, ownership state, and the event evidence timestamp into contact intake.
- Modify `src/main/domain/source/sourceService.ts`: normalize and persist contact evidence fields without losing rank.
- Modify `src/main/domain/identity/identityTypes.ts` and `src/main/domain/identity/identityRepository.ts`: accept, store, and return contact evidence.
- Create `src/main/domain/contacts/contactPresentation.ts`: pure ownership labeling, positive-block ordering, and primary/alternative selection that consumes the existing compliance projection.
- Create `tests/main/domain/contacts/contactPresentation.test.ts`: deterministic ordering and primary-selection tests.

### Lead detail and renderer

- Modify `src/shared/contracts/leadDetailContract.ts`: expand `ContactMethod` with presentation evidence and add `FindContactEligibility` to `LeadDetail`; retain the compliance object from the compliance plan.
- Modify `src/main/domain/founderSalesDomain.ts`: query presentation evidence, preserve the compliance projection, and sort contacts. The existing compliance plan remains the sole final outbound authorization owner.
- Modify `tests/integration/leadDetailService.test.ts`: strict DTO mapping and domain-level refusal cases.
- Create `src/renderer/features/leadInspector/ContactEvidenceCard.tsx`: focused primary/alternative phone rendering.
- Modify `src/renderer/features/leadInspector/InspectorOverview.tsx`: replace flat phone actions and gate Find contact info.
- Modify `src/renderer/features/leadInspector/leadInspector.css`: compact card/list styles and non-color-only blocked treatment.
- Modify `src/renderer/features/leadInspector/LeadInspector.test.tsx`: one/zero/many phone, ordering, disabled reasons, keyboard expansion, and Fit/Timing separation.

### Fit-gated enrichment

- Modify `src/shared/contracts/enrichmentRequestContract.ts`: exact closed refusal vocabulary.
- Modify `src/main/domain/founderSalesDomain.ts`: return a complete eligibility snapshot from `getEnrichmentRequestCandidate`.
- Modify `src/main/sourcing/enrichmentRequestWriter.ts`: reject every failed gate before object-store creation or upload.
- Modify `tests/main/sourcing/enrichmentRequestWriter.test.ts` and `tests/main/suppressionOutbox.test.ts`: one-request behavior, exact refusals, and no side effects.

### Read-only triage snapshot and report artifact

- Create `src/shared/contracts/leadTriageReportContract.ts`: strict snapshot, assessment, recommendation, and report schemas.
- Create `src/main/today/leadTriageReportService.ts`: read-only collector and pure recommendation/report validation helpers.
- Modify `src/main/domain/founderSalesDomain.ts`: expose `getLeadTriageSnapshot({ limit })` using the standard triage ordering.
- Modify `src/main/today/todayService.ts`, `src/main/today/registerTodayIpc.ts`, `src/preload/apis/todayApi.ts`, and `src/main/ipc/registerApplicationIpc.ts`: add one read-only endpoint.
- Modify `src/preload/createCallieApi.ts` only if Today API composition is explicit there. No separate top-level API namespace is needed.
- Create `tests/integration/leadTriageReportService.test.ts`: evidence completeness, distinct-person selection, no mutation, exactly one recommendation, and masking.
- Create `scripts/renderLeadTriageReport.mts`: pure JSON-in/Markdown-out formatter. It must not open SQLite or import Electron main modules.
- Create `tests/main/renderLeadTriageReport.test.ts`: deterministic Markdown and phone masking.
- Generate execution artifacts only under `~/.local/share/callie/triage/YYYY-MM-DD/`: `snapshot.json`, `assessments.json`, and `top-30-lead-triage.md`. These files are private operational evidence and are never staged or committed.

### Packaged verification

- Modify `tests/e2e/founderWorkflow.spec.ts`: representative unreviewed lead and ten-phone candidate presentation.
- Modify `tests/e2e/accessibility.spec.ts`: inspector open state, expanded alternatives, disabled reason text, and axe scan.
- Add a ten-candidate fixture under `tests/fixtures/founderWorkflow/ten-phone-enrichment.json` only if the existing seeded workspace cannot create the state through the real import/sourcing seam.

---

## Exact Interfaces

### Schema 16 contact presentation columns

The compliance plan owns schema 13 and 14. The runtime/recovery plan owns schema 15. Add only these presentation fields to `person_contact_methods` in schema 16:

```sql
source_label TEXT,
vendor_rank INTEGER CHECK (vendor_rank IS NULL OR vendor_rank >= 1),
phone_kind TEXT CHECK (
  phone_kind IS NULL OR phone_kind IN ('mobile','landline','voip','other')
),
ownership_state TEXT NOT NULL DEFAULT 'unknown' CHECK (
  ownership_state IN ('verified_person','vendor_candidate','conflicting_identity','unknown')
),
evidence_observed_at TEXT
```

Do not remove `validation_state`, `dnc_listed`, or `tcpa_flag`; the compliance plan retains the booleans only as compatibility projections. Do not add another scrub timestamp, expiration, area-coverage, TCPA, federal-status, or state-clearance column. Those values already live in schema 13 and 14 and are projected through `contact.compliance`. Existing rows receive null source/rank/kind/timestamp and `ownership_state='unknown'`.

### Existing cloud enrichment contract consumed here

Task 2 of the compliance plan already replaces the ambiguous booleans with a strict nested evidence record. This plan adds no competing wire fields. It consumes:

```ts
{
  e164: string;
  kind: 'mobile' | 'landline' | 'voip' | 'other';
  rank: number;
  compliance: {
    federal_status: 'unknown' | 'verified_clear' | 'listed';
    tcpa_flag: boolean | null;
    covered_area_code: string | null;
    source: 'ftc_download' | 'enrichment_vendor' | 'manual_import' | 'legacy';
    scrubbed_at: string | null;
    expires_at: string | null;
  };
}
```

`payload.vendor` is the source label and `event.observed_at` is the presentation-evidence timestamp. The compliance plan remains responsible for refusing false or incomplete evidence and for enforcing the maximum 31-day federal evidence lifetime.

### Intake and identity interfaces

Extend the compliance-hardened `IntakeContactInput`, `AddContactMethodInput`, and domain `ContactMethod` with:

```ts
export type ContactPresentationEvidence = Readonly<{
  sourceLabel: string | null;
  vendorRank: number | null;
  phoneKind: 'mobile' | 'landline' | 'voip' | 'other' | null;
  ownershipState: 'verified_person' | 'vendor_candidate' | 'conflicting_identity' | 'unknown';
  evidenceObservedAt: string | null;
}>;

// Existing fields, including `complianceEvidence`, remain unchanged.
export type IntakeContactInput = {
  kind: 'phone' | 'email';
  value: string;
  reachability: 'direct' | 'indirect' | 'none';
  validationState: 'unverified' | 'valid' | 'invalid';
  isPrimary?: boolean;
  inContacts?: boolean | null;
  complianceEvidence?: ContactComplianceEvidence;
  presentationEvidence?: Partial<ContactPresentationEvidence>;
};
```

Mapping rules for enrichment phones:

```ts
complianceEvidence: fromCloudCompliance(phone.compliance),
presentationEvidence: {
  sourceLabel: payload.vendor,
  vendorRank: phone.rank,
  phoneKind: phone.kind,
  ownershipState: 'vendor_candidate',
  evidenceObservedAt: event.observed_at,
},
validationState: 'unverified',
isPrimary: phone.rank === 1,
```

`payload.matched_owner` validates the enrichment result's person/property match. It does not prove ownership of any individual phone, so it must not produce `ownershipState: 'verified_person'`.

### Lead detail contact DTO

Extend the compliance-hardened `contactMethodSchema`; do not replace its `compliance` object:

```ts
export const contactMethodSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['phone', 'email']),
  value: z.string().min(1),
  label: z.string().nullable(),
  valid: z.boolean(),
  validationState: z.enum(['unverified', 'valid', 'invalid']),
  reachability: z.enum(['direct', 'indirect', 'none']),
  sourceLabel: z.string().min(1).nullable(),
  vendorRank: z.number().int().positive().nullable(),
  phoneKind: z.enum(['mobile', 'landline', 'voip', 'other']).nullable(),
  ownershipState: z.enum([
    'verified_person', 'vendor_candidate', 'conflicting_identity', 'unknown',
  ]),
  evidenceObservedAt: z.string().datetime({ offset: true }).nullable(),
  compliance: z.object({
    status: phoneComplianceStatusSchema,
    label: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    callRefusalReason: outboundAuthorizationReasonCodeSchema.nullable(),
    textRefusalReason: outboundAuthorizationReasonCodeSchema.nullable(),
  }).strict().nullable(),
}).strict();
```

Add to `leadDetailSchema`:

```ts
findContactEligibility: z.object({
  eligible: z.boolean(),
  refusalReason: z.enum([
    'qualification_required', 'fit_gate_failed', 'identity_or_address_missing',
    'direct_contact_exists', 'suppression_blocked', 'rate_limited',
    'credentials_unavailable',
  ]).nullable(),
}).strict(),
```

### Pure contact presentation helpers

Create `src/main/domain/contacts/contactPresentation.ts`:

```ts
export function isPositivelyBlocked(
  status: PhoneComplianceStatus,
): boolean;

export function comparePhoneCandidates(
  left: ContactMethod,
  right: ContactMethod,
): number;

export function selectPrimaryPhone(
  phones: readonly ContactMethod[],
): { primary: ContactMethod | null; alternatives: ContactMethod[] };
```

Ordering is exactly: positive block last, `verified_clear` before all other nonpositive statuses, ownership confidence (`verified_person`, `vendor_candidate`, `unknown`, `conflicting_identity`), vendor rank with null last, normalized phone string ascending, ID ascending as final stable tie-break. Positive blocks are `federal_dnc_listed` and `tcpa_blocked`; every other non-clear status is still non-actionable through the compliance plan's refusal reason.

A rank-one candidate may be primary if it is not positively blocked. If rank one is positively blocked, select the highest ordered non-positively-blocked candidate. A primary candidate is still not necessarily actionable.

### Enrichment eligibility

Replace the narrow internal candidate with:

```ts
export type EnrichmentCandidate = {
  cloudEntityId: string | null;
  ownerFullName: string;
  situsAddress: {
    line1: string;
    locality: string;
    region: string;
    postalCode: string | null;
  } | null;
  lastRequestedAt: string | null;
  qualificationState: 'unreviewed' | 'eligible' | 'disqualified' | 'merge_review';
  fitBand: 'low' | 'medium' | 'high' | null;
  identityReady: boolean;
  hasUsableDirectContact: boolean;
  suppressionBlocked: boolean;
};
```

Gate order and exact refusal:

1. `qualificationState !== 'eligible'` → `qualification_required`.
2. `fitBand !== 'medium' && fitBand !== 'high'` → `fit_gate_failed`.
3. Missing cloud link, owner name, identity readiness, or address → `identity_or_address_missing`.
4. Existing direct contact with `ownershipState === 'verified_person'`, valid evidence, and non-`none` reachability → `direct_contact_exists`.
5. Opt-out, contact suppression, or unresolved suppression membership → `suppression_blocked`.
6. Inside 30-day request window → `rate_limited`.
7. Missing object-store credentials → `credentials_unavailable`.
8. Otherwise write exactly one request and record the timestamp only after successful upload.

The renderer consumes `detail.findContactEligibility` and does not recreate these rules from `phones.length`.

### Read-only triage snapshot and report contracts

Create `src/shared/contracts/leadTriageReportContract.ts` with:

```ts
export const leadTriageSnapshotRequestSchema = z.object({
  limit: z.number().int().min(20).max(30),
}).strict();

export const triageRecommendationSchema = z.enum([
  'ready_candidate', 'needs_identity', 'needs_compliance',
  'needs_contact', 'watch', 'dismiss_candidate',
]);

export const triageEvidenceCodeSchema = z.enum([
  'organization_property_match',
  'organization_residence_match',
  'organization_business_match',
  'organization_relationship_unknown',
  'fit_low',
  'fit_medium',
  'fit_high',
  'fit_evidence_missing',
  'timing_trigger_active',
  'timing_trigger_stale',
  'timing_evidence_missing',
  'cloud_signal_present',
  'direct_contact_present',
  'no_usable_direct_contact',
  'contact_validation_unknown',
  'contact_validation_invalid',
  'contact_ownership_unverified',
  'compliance_clear',
  'compliance_blocked',
  'compliance_unknown',
  'identity_collision',
  'identity_relationship_unknown',
  'identity_address_missing',
  'enrichment_rate_limited',
]);
export type TriageEvidenceCode = z.infer<typeof triageEvidenceCodeSchema>;

export const triageTriggerCodeSchema = z.enum([
  'assessment_change',
  'permit_activity',
  'tax_activity',
  'rental_activity',
  'property_transfer',
  'other_sanitized',
]);

export const triageCloudSignalCodeSchema = z.enum([
  'assessment',
  'permit',
  'tax',
  'rent',
  'property',
  'portfolio',
  'business',
  'recency',
  'other_sanitized',
]);

export const leadTriageEvidenceSchema = z.object({
  rank: z.number().int().positive(),
  queueIndex: z.number().int().nonnegative(),
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema,
  personName: z.string().min(1),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  organization: z.object({
    label: z.string().nullable(),
    relationship: z.enum([
      'property_owner', 'resident', 'business_principal',
      'mailing_contact', 'unknown',
    ]).nullable(),
    evidenceCodes: z.array(triageEvidenceCodeSchema),
  }).strict(),
  fit: z.object({
    points: z.number().int().nullable(),
    band: z.enum(['low','medium','high']).nullable(),
    evidenceCodes: z.array(triageEvidenceCodeSchema),
  }).strict(),
  timing: z.object({
    value: z.number().int().nullable(),
    band: z.enum(['cold','warm','hot']).nullable(),
    triggers: z.array(z.object({
      code: triageTriggerCodeSchema,
      observedAt: z.string().datetime({ offset: true }),
      expiresAt: z.string().datetime({ offset: true }).nullable(),
    }).strict()),
  }).strict(),
  cloud: z.object({
    fit: z.number().nullable(),
    timing: z.number().nullable(),
    contributions: z.array(z.object({
      signalCode: triageCloudSignalCodeSchema,
      contribution: z.number(),
    }).strict()),
  }).strict(),
  reachability: z.enum(['direct','indirect','none']).nullable(),
  dataConfidence: z.number().int().nullable(),
  contacts: z.object({
    phoneCount: z.number().int().nonnegative(),
    emailCount: z.number().int().nonnegative(),
    usableDirectCount: z.number().int().nonnegative(),
    maskedPrimaryPhone: z.string().nullable(),
    evidenceCodes: z.array(triageEvidenceCodeSchema),
  }).strict(),
  compliance: z.object({
    status: z.enum(['verified_clear','blocked','unknown','mixed']),
    refusalReasonCodes: z.array(outboundAuthorizationReasonCodeSchema),
  }).strict(),
  identityConcernCodes: z.array(triageEvidenceCodeSchema),
}).strict();

export const leadTriageSnapshotSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  requestedLimit: z.number().int().min(20).max(30),
  scannedQueueRows: z.number().int().nonnegative(),
  leads: z.array(leadTriageEvidenceSchema).max(30),
  revisionBefore: z.number().int().nonnegative(),
  revisionAfter: z.number().int().nonnegative(),
  privacyScanPassed: z.literal(true),
}).strict().refine((value) => value.revisionBefore === value.revisionAfter, {
  message: 'Read-only triage collection changed application revision.',
});

export const leadTriageAssessmentSchema = z.object({
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema,
  recommendation: triageRecommendationSchema,
  likelyPriority: z.enum(['P0','P1']).nullable(),
  evidenceCodes: z.array(triageEvidenceCodeSchema).min(1),
  suggestedReviewOrder: z.number().int().positive(),
}).strict();

export function assertTriageArtifactSafe(value: unknown): void;
```

The report builder validates a one-to-one key match between snapshot leads and assessments. Duplicate assessments, missing assessments, or more than one recommendation field are impossible or rejected. `TRIAGE_EVIDENCE_LABELS` is a total `Record<TriageEvidenceCode, string>` owned by the formatter, so human-readable rationale is derived only from reviewed codes rather than copied provider text.

Before the service returns a snapshot or the CLI opens any output file, recursively reject forbidden raw keys (`phone`, `email`, `streetAddress`, `providerPayload`, `rawPayload`, `messageBody`, `messageSubject`) and any string matching a complete NANP/E.164 number, email address, or street-address pattern. `maskedPrimaryPhone` is allowed only when it contains bullets and no complete digit sequence. The successful service result sets `privacyScanPassed: true`; failure returns no partial artifact.

Expose:

```ts
getLeadTriageSnapshot(input: { limit: number }): LeadTriageSnapshot;
```

through Today as:

```ts
TodayProvider.getLeadTriageSnapshot(
  input: LeadTriageSnapshotRequest,
): Promise<LeadTriageSnapshot>;
```

IPC channel: `today:get-lead-triage-snapshot`.

`limit` is the requested count of distinct returned people, not a queue scan cap. The collector must use the full ordered result from the shared `getTriageQueue()` query and continue scanning past duplicate cycles or identity collisions until it has `limit` distinct people or exhausts the queue. It must not add `LIMIT input.limit` to the SQL. `scannedQueueRows` may therefore exceed 30 while `leads.length` remains at most 30.

The collector must use a read transaction or sequential SELECTs only. Capture `currentRevision()` before and after. Never call `setReviewPosition`, `confirmTransition`, `dismissLead`, `recordEnrichmentRequested`, or any repository write method.

---

### Task 1: Add schema-16 contact presentation evidence

**Files:**
- Create: `src/main/db/migrations/0016ContactPresentationEvidence.ts`
- Create: `tests/main/db/migrations/0016ContactPresentationEvidence.test.ts`
- Modify: `src/main/db/migrate.ts`
- Modify: `src/main/db/domainSchema.ts`
- Modify: `src/main/db/plaintextDatabaseUpgrade.ts`
- Modify: `src/main/domain/domainRuntime.ts`
- Modify: `src/main/domain/startup/storageReadiness.ts`
- Modify: `tests/main/migrations.test.ts`
- Modify: `tests/main/healthService.test.ts`
- Modify: `tests/main/db/migrations/0009SourcingFileLedger.test.ts`
- Modify: `tests/main/db/migrations/0011ContactDncFlags.test.ts`
- Modify: `tests/main/db/migrations/0012UpstreamRequestState.test.ts`
- Modify: `tests/main/db/migrations/0015RecoveryMetadata.test.ts`
- Modify: `tests/main/domainStartupAudit.test.ts`
- Modify: `tests/integration/foundationRecovery.test.ts`
- Modify: `tests/integration/migrationBackup.test.ts`
- Modify: `tests/support/migrationBackupScenario.ts`
- Modify: `tests/integration/plaintextDatabaseUpgrade.test.ts`
- Modify: `tests/support/plaintextUpgradeScenario.ts`
- Modify: `tests/e2e/foundation.spec.ts`
- Modify: `tests/support/domainSchemaScenario.ts`

**Interfaces and locked acceptance:**
- Produce only `source_label`, `vendor_rank`, `phone_kind`, `ownership_state`, and `evidence_observed_at` on `person_contact_methods`; preserve every schema-13 compliance column and every schema-14 jurisdiction table/column.
- Startup readiness accepts only `app_meta.schema_version = 16` plus this exact ordered Kysely ledger: `0001Foundation`, `0002DomainFoundation`, `0003Transcripts`, `0004Learnings`, `0005SourcingChannels`, `0006SourcingState`, `0007SourcingOutbox`, `0008DedupeCloudPersons`, `0009SourcingFileLedger`, `0010NoDueDates`, `0011ContactDncFlags`, `0012UpstreamRequestState`, `0013ContactComplianceEvidence`, `0014OutboundJurisdictionClearance`, `0015RecoveryMetadata`, `0016ContactPresentationEvidence`.
- Reject schema 15, schema 17 or any future schema, missing/extra/reordered/duplicate ledger rows, and every schema/ledger mismatch before `createDomainServices` or repository startup. Keep the binary-ordered exact table/index/trigger catalog and normalized load-bearing table SQL checks already owned by `DOMAIN_SCHEMA_MANIFEST`.
- Preserve the schema-15 `backup_receipts`, `recovery_readiness`, and `identity_repair_events` table SQL, their data, indexes, and the SQL text of both `immutable_identity_repair_events` UPDATE and `immutable_identity_repair_events_delete` DELETE triggers byte-for-byte across migration and backup/restore.
- Migration `0015RecoveryMetadata` isolated tests must import `migration0015RecoveryMetadata`, define an explicit through-schema-15 `createMigrationRunner`, use that runner instead of `migrateToLatest` for every migration call, and continue to end at schema 15. Historical operational receipt rows with `schemaVersion: 15` remain recorded evidence unless the fixture explicitly represents the latest schema.
- Plaintext encrypted upgrade accepts schema 16, rejects schema 17 and every future version, and leaves rejected canonical database bytes and upgrade artifacts unchanged.
- Task 1 authorizes tracked code and disposable test fixtures only. It authorizes no founder workspace access, live database access or migration, live snapshot capture, identity repair, AWS/provider action, Terraform action, or any operational action.

The exact normalized schema-16 `person_contact_methods` SQL must be asserted as:

```sql
CREATE TABLE person_contact_methods (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  kind TEXT NOT NULL CHECK (kind IN ('phone', 'email')),
  normalized_value TEXT NOT NULL CHECK (length(normalized_value) > 0),
  raw_value TEXT,
  validation_state TEXT NOT NULL CHECK (
    validation_state IN ('unverified', 'valid', 'invalid')
  ),
  reachability TEXT NOT NULL CHECK (
    reachability IN ('direct', 'indirect', 'none')
  ),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  in_contacts INTEGER CHECK (in_contacts IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dnc_listed INTEGER NOT NULL DEFAULT 0 CHECK (dnc_listed IN (0, 1)),
  tcpa_flag INTEGER NOT NULL DEFAULT 0 CHECK (tcpa_flag IN (0, 1)),
  federal_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (federal_status IN ('unknown', 'verified_clear', 'listed')),
  compliance_tcpa_flag INTEGER NULL
    CHECK (compliance_tcpa_flag IS NULL OR compliance_tcpa_flag IN (0, 1)),
  covered_area_code TEXT NULL
    CHECK (covered_area_code IS NULL OR covered_area_code GLOB '[0-9][0-9][0-9]'),
  compliance_source TEXT NOT NULL DEFAULT 'legacy'
    CHECK (compliance_source IN ('ftc_download', 'enrichment_vendor', 'manual_import', 'legacy')),
  scrubbed_at TEXT NULL,
  compliance_expires_at TEXT NULL,
  source_label TEXT,
  vendor_rank INTEGER CHECK (vendor_rank IS NULL OR vendor_rank >= 1),
  phone_kind TEXT CHECK (
    phone_kind IS NULL OR phone_kind IN ('mobile','landline','voip','other')
  ),
  ownership_state TEXT NOT NULL DEFAULT 'unknown' CHECK (
    ownership_state IN ('verified_person','vendor_candidate','conflicting_identity','unknown')
  ),
  evidence_observed_at TEXT,
  UNIQUE (person_id, kind, normalized_value)
)
```

Assert the ordered `PRAGMA table_info(person_contact_methods)` rows for the five added presentation columns only, without weakening assertions for the pre-existing compliance columns:

```ts
[
  { cid: 19, name: 'source_label', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 20, name: 'vendor_rank', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 21, name: 'phone_kind', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { cid: 22, name: 'ownership_state', type: 'TEXT', notnull: 1, dflt_value: "'unknown'", pk: 0 },
  { cid: 23, name: 'evidence_observed_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
]
```

- [ ] **Step 1: Write the focused failing schema-16 tests.** In `0016ContactPresentationEvidence.test.ts`, create a real schema-15 database with migration 0015, seed phone and email contacts plus schema-13 compliance evidence, schema-14 jurisdiction data, and schema-15 recovery rows. Capture normalized recovery table SQL and both immutable identity-repair trigger SQL strings before migration. Assert 15→16 applies only `0016ContactPresentationEvidence`, sets conservative defaults, enforces every declared CHECK, yields the exact table SQL and ordered five-column `PRAGMA table_info` rows above, preserves compliance/jurisdiction data, and leaves all captured schema-15 SQL/data byte-for-byte equal. Add a second-run idempotence assertion.
- [ ] **Step 2: Add failing startup-boundary tests.** In `domainStartupAudit.test.ts`, cover exact schema 16 success and separate failures for 15, 17, missing `0016`, extra `0017`, reordered rows, duplicate migration names/timestamps, and both directions of schema/ledger mismatch. Assert every failure occurs before domain services/repositories start and assert exact table/index/trigger catalog plus normalized SQL, including `person_contact_methods` and both immutable identity-repair triggers.
- [ ] **Step 3: Add failing recovery and backup tests.** Extend `foundationRecovery.test.ts` and the existing `migrationBackupScenario.ts`/`migrationBackup.test.ts` harness with a schema-15→16 migration backup/restore scenario. Compare recovery tables, rows, indexes, and both identity-repair trigger SQL strings byte-for-byte before migration, in the verified pre-migration backup, after migration, and after restored reopen.
- [ ] **Step 4: Add failing plaintext exact-boundary tests.** Rename the old latest-boundary scenario so encrypted schema 16 is accepted, add encrypted schema 17 rejection, keep a future-version rejection case, and assert rejected canonical bytes and all pre-existing candidate/artifact bytes are unchanged. Update `assertEncryptedSchemaVersionAccepted` to include 16; do not manufacture “older schema” fixtures by migrating to latest and editing only `app_meta` where ledger/catalog fidelity matters.
- [ ] **Step 5: Add failing foundation and packaged assertions.** Update `domainSchemaScenario.ts`, `foundationRecovery.test.ts`, and `foundation.spec.ts` to require exact schema 16, exact ordered 0001…0016 ledger, exact catalog/table/index/trigger SQL, and ordered presentation columns while retaining schema-15 recovery and identity-repair assertions.
- [ ] **Step 6: Run the RED focused schema-16 test and verify it fails because migration 0016 is absent.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/db/migrations/0016ContactPresentationEvidence.test.ts
```

- [ ] **Step 7: Implement the minimal additive migration and register the exact boundary.** Add the five columns in the declared order, update `app_meta` to 16, register `0016ContactPresentationEvidence` after `0015RecoveryMetadata`, extend `domainSchema.ts`, set runtime/readiness to exact schema 16 and exact ledger/catalog SQL, and add 16 but not 17 to `KNOWN_SCHEMA_VERSIONS`. Do not rebuild or rewrite schema-15 recovery tables/triggers.
- [ ] **Step 8: Update only true latest-schema expectations.** Change aggregate/runtime/foundation/plaintext latest expectations to 16, including `healthService.test.ts` and every `migrateToLatest` result, ordered migration list, idempotence boundary, and `app_meta` assertion in `0009SourcingFileLedger.test.ts`, `0011ContactDncFlags.test.ts`, and `0012UpstreamRequestState.test.ts`. In `0015RecoveryMetadata.test.ts`, import `migration0015RecoveryMetadata`, create an explicit `migrateThroughSchema15` runner by appending 0015 to `migrationsThrough14`, replace every `migrateToLatest` call with that runner, and keep all schema-15 expectations unchanged. Leave historical operational receipts carrying recorded `schemaVersion: 15` unchanged.
- [ ] **Step 9: Run focused migration consumers plus aggregate backup verification.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/db/migrations/0016ContactPresentationEvidence.test.ts tests/main/migrations.test.ts tests/main/healthService.test.ts tests/main/db/migrations/0009SourcingFileLedger.test.ts tests/main/db/migrations/0011ContactDncFlags.test.ts tests/main/db/migrations/0012UpstreamRequestState.test.ts tests/main/db/migrations/0015RecoveryMetadata.test.ts tests/integration/migrationBackup.test.ts
```

- [ ] **Step 10: Run readiness, domain, foundation, and plaintext exact-boundary suites.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/domainStartupAudit.test.ts tests/integration/foundationRecovery.test.ts tests/integration/plaintextDatabaseUpgrade.test.ts
```

- [ ] **Step 11: Run the root verification and packaging gates.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run package
```

- [ ] **Step 12: Run the packaged foundation gate serially.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx playwright test --workers=1 tests/e2e/foundation.spec.ts
```

- [ ] **Step 13: Run the whitespace gate and inspect the Task 1 diff.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; git diff --check
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; git diff -- src/main/db/migrations/0016ContactPresentationEvidence.ts tests/main/db/migrations/0016ContactPresentationEvidence.test.ts src/main/db/migrate.ts src/main/db/domainSchema.ts src/main/db/plaintextDatabaseUpgrade.ts src/main/domain/domainRuntime.ts src/main/domain/startup/storageReadiness.ts tests/main/migrations.test.ts tests/main/healthService.test.ts tests/main/db/migrations/0009SourcingFileLedger.test.ts tests/main/db/migrations/0011ContactDncFlags.test.ts tests/main/db/migrations/0012UpstreamRequestState.test.ts tests/main/db/migrations/0015RecoveryMetadata.test.ts tests/main/domainStartupAudit.test.ts tests/integration/foundationRecovery.test.ts tests/integration/migrationBackup.test.ts tests/support/migrationBackupScenario.ts tests/integration/plaintextDatabaseUpgrade.test.ts tests/support/plaintextUpgradeScenario.ts tests/e2e/foundation.spec.ts tests/support/domainSchemaScenario.ts
```

- [ ] **Step 14: Commit only Task 1 files.**

```bash
git add src/main/db/migrations/0016ContactPresentationEvidence.ts tests/main/db/migrations/0016ContactPresentationEvidence.test.ts src/main/db/migrate.ts src/main/db/domainSchema.ts src/main/db/plaintextDatabaseUpgrade.ts src/main/domain/domainRuntime.ts src/main/domain/startup/storageReadiness.ts tests/main/migrations.test.ts tests/main/healthService.test.ts tests/main/db/migrations/0009SourcingFileLedger.test.ts tests/main/db/migrations/0011ContactDncFlags.test.ts tests/main/db/migrations/0012UpstreamRequestState.test.ts tests/main/db/migrations/0015RecoveryMetadata.test.ts tests/main/domainStartupAudit.test.ts tests/integration/foundationRecovery.test.ts tests/integration/migrationBackup.test.ts tests/support/migrationBackupScenario.ts tests/integration/plaintextDatabaseUpgrade.test.ts tests/support/plaintextUpgradeScenario.ts tests/e2e/foundation.spec.ts tests/support/domainSchemaScenario.ts
git commit -m "feat(db): persist contact presentation evidence"
```

### Task 2: Preserve vendor rank, kind, source, and ownership evidence through intake

**Files:**
- Modify: `src/main/sourcing/intakeMapper.ts`
- Modify: `tests/main/sourcing/intakeMapper.test.ts`
- Modify: `src/main/domain/source/sourceService.ts`
- Modify: `src/main/domain/source/intakeReceiptRepository.ts`
- Modify: `src/main/domain/identity/identityTypes.ts`
- Modify: `src/main/domain/identity/identityRepository.ts`
- Modify: `tests/main/intakeReceiptRepository.test.ts`
- Modify: `tests/main/sourceService.test.ts`
- Modify: `tests/main/sourcing/founderSalesDomainUpstream.test.ts`

**Interfaces:**
- Consumes the compliance plan's nested cloud `phone.compliance` contract and schema-16 presentation columns.
- Produces `ContactPresentationEvidence` plus expanded `IntakeContactInput`, `AddContactMethodInput`, and domain `ContactMethod` types without renaming `complianceEvidence`.

- [ ] **Step 1: Add failing mapper tests.** Assert rank 1 and rank 2 survive as `vendorRank`, `phone.kind` survives as `phoneKind`, source is `tracerfy`, ownership remains `vendor_candidate`, `event.observed_at` survives as `evidenceObservedAt`, and the nested compliance record passes through unchanged.
- [ ] **Step 2: Run the mapper test and verify failure because presentation evidence is discarded.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/sourcing/intakeMapper.test.ts
```

- [ ] **Step 3: Extend the intake, normalization, repository, and canonical receipt types.** Carry `validationState` through `IntakeContactInput`, normalized contacts, `AddContactMethodInput`, `ContactMethod`, canonical receipt serialization, and database persistence. Keep compliance merging delegated to `ContactComplianceService`; add presentation persistence independently so an existing matching contact can receive new rank/source metadata without bypassing monotonic compliance merge.
- [ ] **Step 4: Add failing persistence and receipt tests.** Import a two-phone enrichment event, assert both contacts persist `validationState = 'unverified'`, query all schema-16 columns, verify the canonical receipt changes when validation state changes, and verify equivalent replay is idempotent and the primary-contact uniqueness rule does not erase vendor rank.
- [ ] **Step 5: Run mapper and persistence tests and verify the new assertions fail.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/sourcing/intakeMapper.test.ts tests/main/intakeReceiptRepository.test.ts tests/main/sourceService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts
```

- [ ] **Step 6: Implement the presentation merge.** For ordinary intake, preserve a non-null existing `verified_person` or `conflicting_identity` ownership state; otherwise accept current vendor metadata when its `evidenceObservedAt` is newer or equal. Never use vendor rank to prove ownership or compliance.
- [ ] **Step 7: Update canonical receipt serialization so presentation evidence is deterministic and equivalent replays remain no-ops.**
- [ ] **Step 8: Run all focused source/intake tests.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/sourcing/intakeMapper.test.ts tests/main/intakeReceiptRepository.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts tests/main/sourceService.test.ts tests/main/contactComplianceService.test.ts
```

- [ ] **Step 9: Commit.**

```bash
git add src/main/sourcing/intakeMapper.ts tests/main/sourcing/intakeMapper.test.ts src/main/domain/source/sourceService.ts src/main/domain/source/intakeReceiptRepository.ts src/main/domain/identity/identityTypes.ts src/main/domain/identity/identityRepository.ts tests/main/intakeReceiptRepository.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts tests/main/sourceService.test.ts
git commit -m "feat(contacts): retain enrichment presentation evidence"
```

### Task 3: Add deterministic contact presentation on top of the final outbound gate

**Files:**
- Create: `src/main/domain/contacts/contactPresentation.ts`
- Create: `tests/main/domain/contacts/contactPresentation.test.ts`
- Modify: `src/shared/contracts/leadDetailContract.ts`
- Modify: `src/main/domain/founderSalesDomain.ts`
- Modify: `tests/integration/leadDetailService.test.ts`

**Interfaces:**
- Produces the pure presentation helper signatures and expanded `ContactMethod` DTO defined above.
- Consumes `contact.compliance.status`, `callRefusalReason`, and `textRefusalReason` from the compliance plan. It does not replace or weaken `OutboundPermissionService` or `beginOutbound` authorization.

- [ ] **Step 1: Write table-driven failing tests for positive-block classification.** Only `federal_dnc_listed` and `tcpa_blocked` sort to the positive-block group. Unknown, expired, uncovered, state-required, and outside-window statuses remain non-actionable but are not mislabeled as positive list hits.
- [ ] **Step 2: Write failing deterministic comparator tests.** Use shuffled arrays, duplicate ranks, and mixed ownership/compliance states. Assert normalized phone and ID tie-breaks.
- [ ] **Step 3: Run and verify failure because helpers do not exist.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/domain/contacts/contactPresentation.test.ts
```

- [ ] **Step 4: Implement the pure ordering and primary-selection helpers.** Do not return a reusable authorization boolean. UI enablement comes only from the compliance projection's channel-specific null refusal reason.
- [ ] **Step 5: Expand the strict lead-detail contract and domain contact SQL.** Include schema-16 presentation columns and the existing compliance projection. Include `is_primary` only as legacy evidence; primary presentation is selected by `selectPrimaryPhone`, not by blindly trusting it.
- [ ] **Step 6: Add domain integration tests.** Assert validation state, all presentation fields, and compliance labels map correctly, mixed candidates order deterministically, and a detail snapshot that appears allowed can still be refused by the compliance plan's final `beginOutbound` gate after state changes.
- [ ] **Step 7: Run the compliance plan's focused final-gate tests unchanged.** Any required edit to `beginOutbound` is a regression unless it only adapts the expanded SELECT shape without changing authorization ownership.
- [ ] **Step 8: Run focused tests.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/domain/contacts/contactPresentation.test.ts tests/integration/leadDetailService.test.ts tests/main/outboundAuthorization.test.ts tests/main/outboundPermissionService.test.ts tests/main/noBlendedScore.test.ts tests/shared/noBlendedScoreContract.test.ts
```

- [ ] **Step 9: Commit.**

```bash
git add src/main/domain/contacts/contactPresentation.ts tests/main/domain/contacts/contactPresentation.test.ts src/shared/contracts/leadDetailContract.ts src/main/domain/founderSalesDomain.ts tests/integration/leadDetailService.test.ts
git commit -m "feat(contacts): order contact candidates deterministically"
```

### Task 4: Replace the flat phone-button list with primary and collapsed alternatives

**Files:**
- Create: `src/renderer/features/leadInspector/ContactEvidenceCard.tsx`
- Modify: `src/renderer/features/leadInspector/InspectorOverview.tsx`
- Modify: `src/renderer/features/leadInspector/leadInspector.css`
- Modify: `src/renderer/features/leadInspector/LeadInspector.test.tsx`

**Interfaces:**

```ts
export type ContactEvidenceCardProps = {
  detail: LeadDetail;
  primary: ContactMethod | null;
  alternatives: readonly ContactMethod[];
  onBeginOutbound(request: BeginOutboundRequest): void;
};
```

- [ ] **Step 1: Update the test fixture factory for the expanded strict contact DTO.** Add a helper that creates conservative unknown evidence unless explicitly overridden.
- [ ] **Step 2: Write the failing ten-candidate test.** Assert one region named `Primary phone candidate`, rank/source/ownership/validation/compliance/timestamps visible, one button named `Show 9 alternative numbers`, and zero alternative rows before expansion.
- [ ] **Step 3: Write failing blocked/unknown action tests.** Assert no enabled Call/Text control and visible refusal text for each disabled control.
- [ ] **Step 4: Write failing keyboard/accessibility tests.** Focus the alternatives button, press Enter/Space, assert `aria-expanded`, deterministic row order, focusable evidence rows, and `Hide 9 alternative numbers` after expansion.
- [ ] **Step 5: Run the focused renderer test and verify failure.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run src/renderer/features/leadInspector/LeadInspector.test.tsx
```

- [ ] **Step 6: Implement the focused component.** Each row uses a semantic `<article>` or `<li tabIndex={0}>`; display `Unverified`, `Valid`, or `Invalid` from `validationState` as text separate from ownership and compliance; badges duplicate status in text; disabled buttons carry `aria-describedby` pointing to the visible `contact.compliance` refusal label. Call is enabled only when `validationState === 'valid'` and `callRefusalReason === null`; Text is enabled only when `validationState === 'valid'` and `textRefusalReason === null`; person opt-out still disables both. The alternatives control has an explicit accessible name and `aria-controls`.
- [ ] **Step 7: Replace only the phone portion of Reach out.** Keep email rendering as one row per email. Do not render ten equal Call/Text pairs.
- [ ] **Step 8: Add compact CSS.** Use one bordered primary card, dense metadata `<dl>`, subdued alternatives, and blocked text/icon treatment that remains understandable without color.
- [ ] **Step 9: Run renderer tests.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run src/renderer/features/leadInspector/LeadInspector.test.tsx src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx src/renderer/components/foundationPrimitives.test.tsx
```

- [ ] **Step 10: Commit.**

```bash
git add src/renderer/features/leadInspector/ContactEvidenceCard.tsx src/renderer/features/leadInspector/InspectorOverview.tsx src/renderer/features/leadInspector/leadInspector.css src/renderer/features/leadInspector/LeadInspector.test.tsx
git commit -m "feat(inspector): present ranked contact candidates safely"
```

### Task 5: Enforce fit-gated, founder-approved single-lead enrichment

**Files:**
- Modify: `src/shared/contracts/enrichmentRequestContract.ts`
- Modify: `src/shared/contracts/leadDetailContract.ts`
- Modify: `src/main/domain/founderSalesDomain.ts`
- Modify: `src/main/sourcing/enrichmentRequestWriter.ts`
- Modify: `tests/main/sourcing/enrichmentRequestWriter.test.ts`
- Modify: `tests/main/suppressionOutbox.test.ts`
- Modify: `tests/integration/leadDetailService.test.ts`
- Modify: `src/renderer/features/leadInspector/InspectorOverview.tsx`
- Modify: `src/renderer/features/leadInspector/LeadInspector.test.tsx`

**Interfaces:**
- Consumes the expanded `EnrichmentCandidate` and `findContactEligibility` signatures above.
- Extends `findContactInfoReceiptSchema.refusalReason` with all exact gate reasons.

- [ ] **Step 1: Write failing writer tests for every gate in the stated order.** For each refusal assert zero object-store creation, zero upload, and zero `recordEnrichmentRequested` calls.
- [ ] **Step 2: Write failing domain candidate tests.** Seed unreviewed, low-fit, merge-review, direct-contact, opted-out/suppressed, and fully eligible leads.
- [ ] **Step 3: Run and verify failures.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/sourcing/enrichmentRequestWriter.test.ts tests/main/suppressionOutbox.test.ts tests/integration/leadDetailService.test.ts
```

- [ ] **Step 4: Implement domain eligibility snapshot and exact receipt reasons.** Do not infer eligibility from `phones.length === 0`.
- [ ] **Step 5: Update renderer tests.** Assert Find contact info is hidden or disabled before founder qualification, for low fit, missing identity/address, direct verified contact, suppression, and rate limit. Assert it is enabled only for the fully eligible case and one click makes one API call.
- [ ] **Step 6: Render the domain refusal reason next to the button.** Keep receipt status in `role="status"`; request failures remain non-destructive.
- [ ] **Step 7: Run focused tests.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/sourcing/enrichmentRequestWriter.test.ts tests/main/suppressionOutbox.test.ts tests/integration/leadDetailService.test.ts src/renderer/features/leadInspector/LeadInspector.test.tsx
```

- [ ] **Step 8: Commit.**

```bash
git add src/shared/contracts/enrichmentRequestContract.ts src/shared/contracts/leadDetailContract.ts src/main/domain/founderSalesDomain.ts src/main/sourcing/enrichmentRequestWriter.ts tests/main/sourcing/enrichmentRequestWriter.test.ts tests/main/suppressionOutbox.test.ts tests/integration/leadDetailService.test.ts src/renderer/features/leadInspector/InspectorOverview.tsx src/renderer/features/leadInspector/LeadInspector.test.tsx
git commit -m "feat(enrichment): require qualification and fit gates"
```

### Task 6: Add a strictly read-only top-30 triage snapshot endpoint

**Files:**
- Create: `src/shared/contracts/leadTriageReportContract.ts`
- Create: `src/main/today/leadTriageReportService.ts`
- Create: `tests/integration/leadTriageReportService.test.ts`
- Modify: `src/main/domain/founderSalesDomain.ts`
- Modify: `src/main/today/todayService.ts`
- Modify: `src/main/today/registerTodayIpc.ts`
- Modify: `src/preload/apis/todayApi.ts`
- Modify: `src/main/ipc/registerApplicationIpc.ts`
- Modify: `tests/main/registerTodayIpc.test.ts`
- Modify: `tests/integration/preload.test.ts`

**Interfaces:**
- Produces `getLeadTriageSnapshot({ limit: 20..30 })` and IPC channel `today:get-lead-triage-snapshot`.
- No mutation interface is added.

- [ ] **Step 1: Write strict contract tests.** Reject limits outside 20–30, unknown keys, duplicate IDs, unmasked full phone values, email addresses, street addresses, raw/provider payload keys, non-code evidence strings, missing `privacyScanPassed`, and mismatched before/after revisions.
- [ ] **Step 2: Write a failing integration test with 35 queue rows, duplicate/collision evidence, mixed Fit/Timing, triggers, contacts, and compliance.** Assert the first 30 distinct people follow `getTriageQueue()` order; if duplicate cycles occur, assert additional queue rows are scanned to reach 30 distinct people.
- [ ] **Step 3: Snapshot all mutation-sensitive tables before collection.** At minimum hash/count `persons`, `prospects`, `sales_cycles`, `next_actions`, `activities`, `review_position`, `sourcing_enrichment_requests`, and sourcing outboxes. Assert byte-equivalent selected rows afterward and equal domain revisions.
- [ ] **Step 4: Run and verify failure.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/integration/leadTriageReportService.test.ts
```

- [ ] **Step 5: Implement read-only selection.** Reuse a shared private SQL/order builder extracted from `getTriageQueue()` so UI triage and report triage cannot drift. Fetch the full ordered queue, scan until the distinct-person result target is met or the queue ends, and do not copy a second ordering literal or apply a 30-row SQL limit.
- [ ] **Step 6: Aggregate evidence with SELECT-only helpers.** Include stable IDs, locality/region/postal, constrained organization/property relationship enums, persisted Fit/Timing projections, dated trigger codes, sanitized cloud signal codes, reachability/confidence, contact counts/status codes, and identity concern codes. Never forward provider descriptions, contact values, addresses, subjects, bodies, or raw payload fragments.
- [ ] **Step 7: Mask phone numbers.** For E.164, emit `+1••• ••• 0100` or an equivalent deterministic last-four display. Never include the complete value in the DTO.
- [ ] **Step 8: Run the recursive privacy guard before returning, set `privacyScanPassed: true` only after it succeeds, and wire provider, IPC, preload, and API-composition tests.** The endpoint takes a validated request and returns the strict snapshot or no artifact.
- [ ] **Step 9: Run focused tests.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/integration/leadTriageReportService.test.ts tests/main/registerTodayIpc.test.ts tests/integration/preload.test.ts
```

- [ ] **Step 10: Commit.**

```bash
git add src/shared/contracts/leadTriageReportContract.ts src/main/today/leadTriageReportService.ts tests/integration/leadTriageReportService.test.ts src/main/domain/founderSalesDomain.ts src/main/today/todayService.ts src/main/today/registerTodayIpc.ts src/preload/apis/todayApi.ts src/main/ipc/registerApplicationIpc.ts tests/main/registerTodayIpc.test.ts tests/integration/preload.test.ts
git commit -m "feat(triage): expose read-only evidence snapshot"
```

### Task 7: Add deterministic report rendering and the Jcode read-only runbook

**Files:**
- Create: `scripts/renderLeadTriageReport.mts`
- Create: `tests/main/renderLeadTriageReport.test.ts`
- Generated after implementation outside the repository: `~/.local/share/callie/triage/YYYY-MM-DD/{snapshot.json,assessments.json,top-30-lead-triage.md}`

**Interfaces:**

```ts
export function buildLeadTriageReport(input: {
  snapshot: LeadTriageSnapshot;
  assessments: readonly LeadTriageAssessment[];
}): string;
```

CLI:

```text
node scripts/renderLeadTriageReport.mts --snapshot <snapshot.json> --assessments <assessments.json> --output <report.md>
```

- [ ] **Step 1: Write failing formatter tests.** Assert the exact table columns from the spec, count by recommendation, likely P0, likely P1, compliance-blocked, identity-repair, and suggested founder review order sections.
- [ ] **Step 2: Assert one-to-one assessment validation.** Missing, extra, or duplicate `(personId, salesCycleId)` keys fail. Each lead has exactly one recommendation enum.
- [ ] **Step 3: Assert privacy and determinism.** Full phone strings, email addresses, street addresses, provider payloads, subjects, and bodies fail before any output file is opened; identical inputs produce byte-identical Markdown; report row order is snapshot rank and founder order is `suggestedReviewOrder`.
- [ ] **Step 4: Run and verify failure.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/renderLeadTriageReport.test.ts
```

- [ ] **Step 5: Implement the pure formatter and non-database CLI.** Validate snapshot and assessment schemas, require `privacyScanPassed: true`, run the recursive privacy guard over both inputs and rendered Markdown before opening the destination, and map only closed evidence codes through `TRIAGE_EVIDENCE_LABELS`. The script may read/write only the explicitly named JSON/Markdown paths. It must not import `database.ts`, keychain code, domain repositories, Electron, or AWS clients. It refuses an output path inside the repository and creates output with mode 0600.
- [ ] **Step 6: Run focused tests.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/renderLeadTriageReport.test.ts tests/integration/leadTriageReportService.test.ts
```

- [ ] **Step 7: Commit code, not a live report yet.**

```bash
git add scripts/renderLeadTriageReport.mts tests/main/renderLeadTriageReport.test.ts
git commit -m "feat(triage): render founder review report"
```

## Read-only top-30 workflow and report artifact

1. Complete Tasks 1–7 and all safety/runtime prerequisites from the approved rollout sequence.
2. Package the application and launch it against the founder workspace without invoking any renderer mutation controls.
3. Capture baseline health and revision:

```js
const healthBefore = await window.callie.health.get();
const todayBefore = await window.callie.today.get();
```

4. Fetch exactly one read-only snapshot:

```js
const snapshot = await window.callie.today.getLeadTriageSnapshot({ limit: 30 });
```

5. Assert in the capture session:

```js
if (snapshot.revisionBefore !== snapshot.revisionAfter) throw new Error('triage mutated state');
if (snapshot.privacyScanPassed !== true) throw new Error('triage privacy scan did not pass');
if (snapshot.leads.length > 30) throw new Error('too many leads');
if (new Set(snapshot.leads.map((lead) => lead.personId)).size !== snapshot.leads.length) {
  throw new Error('snapshot is not distinct by person');
}
```

6. Only after strict schema validation and `privacyScanPassed === true`, create `~/.local/share/callie/triage/<UTC-date>/` with mode 0700 and save `snapshot.json` with mode 0600. Do not copy unmasked contact values or add free-form evidence text.
7. Jcode reviews each evidence object in rank order and creates one `LeadTriageAssessment` per row. Recommendation precedence for consistency, without creating a blended score:
   - unresolved identity/duplicate/ownership relationship → `needs_identity`;
   - exact approved disqualification gate clearly applies → `dismiss_candidate`;
   - sufficient fit/timing but compliance is blocked, expired, uncovered, state-required, or unknown → `needs_compliance`;
   - fit gate passes, identity/address pass, no usable direct contact, suppression permits, and rate window permits → `needs_contact`;
   - high/medium fit with insufficient current timing → `watch`;
   - otherwise evidence supports founder review-to-ready → `ready_candidate`.
8. Set `likelyPriority` only from the approved matrix. P0 additionally requires direct ownership-validated reachability, sufficient confidence, and current federal/state clearance. Never promote based on compliance.
9. Render the report:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; TRIAGE_DIR="$HOME/.local/share/callie/triage/$(date -u +%F)"; umask 077; mkdir -p "$TRIAGE_DIR"; chmod 700 "$TRIAGE_DIR"; node scripts/renderLeadTriageReport.mts --snapshot "$TRIAGE_DIR/snapshot.json" --assessments "$TRIAGE_DIR/assessments.json" --output "$TRIAGE_DIR/top-30-lead-triage.md"; chmod 600 "$TRIAGE_DIR"/*
```

10. Re-read health/Today and compare revisions:

```js
const todayAfter = await window.callie.today.get();
if (todayAfter.revision !== todayBefore.revision) throw new Error('live revision changed during triage');
```

11. Review the generated Markdown for full phone/email leakage, exactly 30 or the available fewer distinct records, exactly one recommendation per row, and all summary sections.
12. Present the external report to the founder with the `open` tool or side panel. Do not stage or commit the snapshot, assessments, or report. Retain or delete the private directory only on the founder's instruction.

### Report template

```markdown
# Top 30 Unreviewed Lead Triage

Generated: `<UTC timestamp>`
Queue ordering: standard application triage ordering
State changes: none
Snapshot revision: `<revisionBefore>` → `<revisionAfter>`
Distinct people: `<count>`
Queue rows scanned: `<count>`

## Recommendations

| Rank | Lead | Fit | Timing | Reachability | Confidence | Compliance | Recommendation | Evidence codes |
|---|---|---|---|---|---|---|---|---|
| 1 | `<display name + stable IDs>` | `High 24/30` | `Hot 31/40` | `Direct` | `8/10` | `Verified clear` | `ready_candidate` | `fit_high, timing_trigger_active, compliance_clear` |

## Counts by recommendation

- Ready candidate: `<n>`
- Needs identity: `<n>`
- Needs compliance: `<n>`
- Needs contact: `<n>`
- Watch: `<n>`
- Dismiss candidate: `<n>`

## Likely P0 candidates

- `<rank and stable IDs, rationale>`

## Likely P1 candidates

- `<rank and stable IDs, rationale>`

## Blocked by compliance

- `<rank, stable IDs, exact blocked/unknown refusal code>`

## Needs identity repair

- `<rank, stable IDs, identity concern code>`

## Suggested founder review order

1. `<rank, stable IDs, recommendation, evidence codes>`
```

### Task 8: Full verification and packaged-app walkthrough

**Files:**
- Modify: `tests/e2e/founderWorkflow.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Optional fixture: `tests/fixtures/founderWorkflow/ten-phone-enrichment.json`

- [ ] **Step 1: Add a packaged test for a representative unreviewed lead.** Open Overview and assert Identity/Review, Fit, Timing, Reachability, confidence, compliance, and decision controls remain separately understandable.
- [ ] **Step 2: Add a packaged test for ten phone candidates.** Assert one primary card, nine collapsed alternatives, explicit source/rank/validation/ownership/compliance status, no enabled actions for unverified/invalid/blocked/unknown rows, deterministic expansion order, and no equal flat button list.
- [ ] **Step 3: Add accessibility coverage.** Open the inspector, expand alternatives with keyboard, verify accessible names/`aria-expanded`/visible refusal reasons, then run axe with the existing legacy-mode convention.
- [ ] **Step 4: Run typecheck, lint, and all unit/integration tests.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run lint:tracked
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test
```

- [ ] **Step 5: Build and verify the packaged app and encrypted SQLite native staging.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:package
```

- [ ] **Step 6: Run the focused packaged workflows.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx playwright test --workers=1 tests/e2e/founderWorkflow.spec.ts tests/e2e/accessibility.spec.ts
```

- [ ] **Step 7: Manually walk the packaged app.** Verify the representative unreviewed lead and the known enriched resident with ten candidates. Use keyboard only once through the alternatives path. Confirm blocked/unknown refusal text is visible and no action fires.
- [ ] **Step 8: Verify a schema-15 workspace migration backup.** Launch a disposable copy of a schema-15 encrypted workspace, confirm a verified backup is created before schema 16, inspect health, and confirm contact rows retain compliance evidence while receiving conservative presentation defaults.
- [ ] **Step 9: Run the read-only top-30 workflow above.** Confirm before/after revisions and all mutation-sensitive table snapshots are unchanged.
- [ ] **Step 10: Commit E2E coverage.**

```bash
git add tests/e2e/founderWorkflow.spec.ts tests/e2e/accessibility.spec.ts
if [ -f tests/fixtures/founderWorkflow/ten-phone-enrichment.json ]; then git add tests/fixtures/founderWorkflow/ten-phone-enrichment.json; fi
git commit -m "test: verify safe lead review in packaged app"
```

- [ ] **Step 11: Final verification after all commits.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:release
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:package
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run test:e2e
```

## Acceptance Traceability

- One primary plus nine collapsed alternatives: Task 4 tests and Task 8 packaged test.
- Rank/source visible: Tasks 2, 3, 4.
- Ownership and compliance separate: Tasks 3, 4.
- Per-number validation visible and actionable only when valid: Tasks 2, 3, 4, 8.
- Blocked/unknown never actionable: Tasks 3, 4, 8.
- Deterministic alternatives: Task 3 comparator and Task 4 renderer test.
- Fit-gated single enrichment: Task 5.
- Fit and Timing remain separate: existing and updated `LeadInspector.test.tsx`, no-blended-score tests, Task 8 walkthrough.
- Read-only collection: Task 6 table/revision invariance test and execution runbook.
- Exactly one recommendation: Task 7 strict one-to-one assessments and formatter tests.
- Masked report: Tasks 6 and 7 closed evidence codes, recursive privacy guard, and pre-write assertions.
- Packaged app: Task 8 `verify:package`, focused Playwright, full E2E, and manual walkthrough.

## Plan Self-Review Result

- Schema 16 waits for full runtime Task 13 completion, so schema-15 identity tooling never opens a schema-16 workspace.
- Vendor phone `validationState` flows through mapper, normalized intake, canonical receipt, repository, domain DTO, and visible per-number UI status.
- A 20–30 result limit never caps queue scanning; the service scans the full shared ordering until it reaches the requested number of distinct people or exhausts the queue.
- Snapshot and assessment evidence uses closed codes, and recursive phone/email/address/provider-payload checks run before a snapshot is returned or any report file is opened.
- The optional ten-phone fixture is staged only when present.
- Spec coverage: all non-negotiable contact, review, enrichment, triage, accessibility, and verification requirements map to tasks above.
- Current schema finding: `dnc_listed` and `tcpa_flag` already exist, and rank currently influences `is_primary` transiently in `intakeMapper.ts`, but rank and vendor/source are not persisted. No ownership state, scrub freshness/expiration, area coverage, or state clearance fields exist. Schema/contract additions in Tasks 1–2 are therefore required.
- Type consistency: contact evidence names are identical across intake, identity, persistence, lead-detail DTO, and pure eligibility helpers.
- Mutation safety: the report endpoint is read-only; the formatter cannot open the database; the live runbook verifies revision/table invariance.
- Command compliance: every `npm` and `npx` command is prefixed with the required Node 24/Homebrew PATH export.
