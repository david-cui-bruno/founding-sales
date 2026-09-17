# Outbound Compliance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every founder-initiated call or text fail closed unless permanent opt-out, federal evidence, TCPA, recipient jurisdiction, state obligations, and recipient-local contact-window checks all authorize the exact contact immediately before the outbound activity handoff.

**Architecture:** Add explicit contact evidence and jurisdiction records in SQLite, preserving current booleans only as compatibility projections. Centralize final authorization in a pure evaluator plus the existing `OutboundPermissionService`, and call it inside the same `BEGIN IMMEDIATE` transaction immediately before `appendActivity`. Make suppression uploads immutable, process S3 versions by key/version/ETag/checksum, validate the complete object before any writes, and provide replay/reconciliation modes before schedules or outreach resume.

**Tech Stack:** TypeScript 5.9, Electron 44, React 19, Kysely/SQLite, Zod 4, Vitest 2, AWS SDK v3, Lambda, DynamoDB, S3 versioning, OpenTofu/Terraform.

**Spec:** `docs/superpowers/specs/2026-09-04-outbound-compliance-hardening-design.md`


## Global Constraints

- Unknown compliance state is blocked, never clear.
- Person-level opt-out is permanent and has highest precedence.
- A federal `listed` result or `tcpaFlag === true` is monotonic. Ordinary intake cannot clear it.
- `verified_clear` is usable only when its evidence is unexpired and covers the phone's actual NANP area code.
- Federal clear evidence may expire no later than 31 days after `scrubbedAt`; schedule refresh at 28 days so the authorization gate fails closed before the legal evidence window can lapse.
- Current enrichment-vendor payloads do not carry authoritative scrub coverage or expiry. A vendor `false` therefore maps to `unknown`, not `verified_clear`. Positive vendor results still strengthen the block.
- Legacy positive booleans remain blocked. Legacy negative booleans migrate to unknown.
- State and calling-window checks use separately stored recipient jurisdiction/timezone, never phone area code as jurisdiction.
- Call eligibility and call-recording consent remain separate decisions. Do not add recording consent to `OutboundAuthorizationDecision`, infer it from an allowed call, or start recording from this gate.
- MA calls remain blocked. RI/CT remain blocked while registration, consent, or state-list obligations are unknown.
- Final authorization is recalculated inside `FounderSalesDomain.beginOutbound`, after loading the current contact and cycle and immediately before `EventRepository.appendActivity`.
- The final gate authorizes but never initiates a call or message. The existing app handoff remains the append-only outbound activity command.
- Suppression objects use `upstream/suppression/YYYY-MM-DD/<timestamp>-<batch-id>.ndjson` and are never overwritten.
- One malformed nonblank row fails the whole suppression object before any suppression write or ledger write.
- Do not log names, phones, emails, contact HMACs, or normalized contact values.
- Every `npm` or `npx` command below starts with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`.

---

## File and ownership map

### Explicit contact evidence

- Create `src/main/domain/compliance/contactComplianceTypes.ts`: canonical Zod schemas and TypeScript types for federal status, evidence source, evidence record, merge result, and correction command.
- Create `src/main/domain/compliance/contactCompliance.ts`: pure normalization, area-code extraction, evidence usability, monotonic merge, and compatibility projection functions.
- Create `src/main/db/migrations/0013ContactComplianceEvidence.ts`: evidence columns plus append-only audit table and safe legacy backfill.
- Create `tests/main/db/migrations/0013ContactComplianceEvidence.test.ts`.
- Create `tests/main/contactCompliance.test.ts`.
- Modify `src/main/db/domainSchema.ts`, `src/main/db/migrate.ts`, `src/main/domain/identity/identityTypes.ts`, and `src/main/domain/identity/identityRepository.ts`.

### Intake and authoritative correction

- Modify `src/main/domain/source/sourceService.ts` so every matching contact executes a compliance merge instead of being skipped.
- Modify `src/main/domain/source/sourceTypes.ts` and the normalized command schema in `src/main/domain/source/sourceService.ts` to carry `ContactComplianceEvidence` for phones.
- Modify `src/main/sourcing/intakeMapper.ts` and its tests.
- Modify `cloud/lambdas/enricher/src/enrich.ts`, `cloud/lambdas/enricher/test/enrich.test.ts`, `cloud/lambdas/shared/src/sourceEvent.ts`, `cloud/lambdas/shared/test/enrichment.test.ts`, `src/shared/contracts/cloudSourceEventContract.ts`, and `tests/main/sourcing/cloudSourceEventContract.test.ts` so missing or negative-only vendor fields do not become clear.
- Create `src/main/domain/compliance/contactComplianceService.ts`: transactional merge and audited authoritative correction commands.
- Modify `src/main/domain/createDomainServices.ts` to compose the service.

### Jurisdiction and final authorization

- Create `src/main/db/migrations/0014OutboundJurisdictionClearance.ts`: recipient jurisdiction and state clearance tables.
- Create `tests/main/db/migrations/0014OutboundJurisdictionClearance.test.ts`.
- Create `src/main/domain/compliance/outboundAuthorization.ts`: pure final decision evaluator and stable reason-code union.
- Create `src/main/domain/compliance/jurisdictionRepository.ts`: strict reads and audited writes for recipient jurisdiction and state clearance.
- Create `tests/main/outboundAuthorization.test.ts` and `tests/main/jurisdictionRepository.test.ts`.
- Modify `src/main/domain/optOut/outboundPermissionService.ts`, `src/main/domain/optOut/optOutTypes.ts`, `src/main/domain/support/domainErrors.ts`, `src/main/domain/createDomainServices.ts`, `src/main/domain/founderSalesDomain.ts`, `tests/main/outboundPermissionService.test.ts`, `tests/integration/leadDetailService.test.ts`, and `tests/main/sourcing/founderSalesDomainUpstream.test.ts`.

### UI projection

- Modify `src/shared/contracts/leadDetailContract.ts` to replace ambiguous booleans in the renderer contract with an explicit phone compliance projection.
- Modify `src/main/domain/founderSalesDomain.ts` to project current status and refusal reason.
- Modify `src/renderer/features/leadInspector/InspectorOverview.tsx`, `src/renderer/features/leadInspector/LeadInspector.test.tsx`, and `src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx`.

### Immutable suppression and replay

- Modify `src/main/sourcing/upstreamSync.ts`, `src/main/startApplication.ts`, and `tests/main/sourcing/upstreamSync.test.ts`.
- Modify comments only where contract paths are documented in `src/shared/contracts/suppressionUploadContract.ts` and `cloud/lambdas/shared/src/suppressionUpload.ts`; the row schema itself remains unchanged.
- Refactor `cloud/lambdas/suppression-sync/src/handler.ts` and `cloud/lambdas/suppression-sync/test/handler.test.ts`.
- Create `cloud/lambdas/suppression-sync/src/suppressionObject.ts`: object identity, checksum, parsing, and validation.
- Create `cloud/lambdas/suppression-sync/src/replay.ts`: historical version ordering, union, quarantine report, reconciliation, and evidence report.
- Create `cloud/lambdas/suppression-sync/test/suppressionObject.test.ts` and `cloud/lambdas/suppression-sync/test/replay.test.ts`.
- Modify `cloud/terraform/iam.tf`, `cloud/terraform/s3.tf`, `cloud/terraform/alarms.tf`, and `cloud/terraform/adapters.tf`.

---

## Task 0: Operational safety hold

**Files:** No repository changes.

**Produces:** A recorded operational checkpoint confirming that cloud enrichment and prospect outreach remain paused throughout implementation and replay.

- [ ] Confirm `var.schedules_enabled = false` in the deployment input actually used for the target environment, or disable the EventBridge rules for at least `enricher` and `suppression-sync` before deploying code.
- [ ] Record the UTC pause time, deployed Lambda versions, inbox bucket versioning status, suppression-table item count, and current EventBridge rule states in the rollout ticket.
- [ ] Do not delete or overwrite any S3 object, DynamoDB item, or local outbox row.
- [ ] Before Task 1, execute runtime/recovery Task 0 and Hold Point 0 from `2026-09-04-runtime-recovery-security-hardening.md`. Do not begin repository implementation while known exposed provider or AWS credentials remain active.

**Verification commands:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
cd cloud/terraform
tofu state show 'aws_cloudwatch_event_rule.adapters["enricher"]'
tofu state show 'aws_cloudwatch_event_rule.adapters["suppression-sync"]'
aws events describe-rule --name callie-sourcing-enricher-schedule
aws events describe-rule --name callie-sourcing-suppression-sync-schedule
aws s3api get-bucket-versioning --bucket "$INBOX_BUCKET"
```

**Commit:** None.

---

## Task 1: Explicit unknown, clear, and listed contact evidence

**Files:**

- Create `src/main/domain/compliance/contactComplianceTypes.ts`
- Create `src/main/domain/compliance/contactCompliance.ts`
- Create `src/main/db/migrations/0013ContactComplianceEvidence.ts`
- Create `tests/main/contactCompliance.test.ts`
- Create `tests/main/db/migrations/0013ContactComplianceEvidence.test.ts`
- Modify `src/main/db/domainSchema.ts`
- Modify `src/main/db/migrate.ts`
- Modify `tests/main/migrations.test.ts`
- Modify `src/main/domain/identity/identityTypes.ts`
- Modify `src/main/domain/identity/identityRepository.ts`

**Interfaces:**

```ts
export const federalContactStatusSchema = z.enum([
  'unknown', 'verified_clear', 'listed',
]);
export const contactComplianceSourceSchema = z.enum([
  'ftc_download', 'enrichment_vendor', 'manual_import', 'legacy',
]);

export type ContactComplianceEvidence = Readonly<{
  federalStatus: 'unknown' | 'verified_clear' | 'listed';
  tcpaFlag: boolean | null;
  coveredAreaCode: string | null;
  source: 'ftc_download' | 'enrichment_vendor' | 'manual_import' | 'legacy';
  scrubbedAt: string | null;
  expiresAt: string | null;
}>;

export function phoneAreaCode(normalizedPhone: string): string | null;
export function compatibilityFlags(evidence: ContactComplianceEvidence): {
  dncListed: boolean;
  tcpaFlag: boolean;
};
export function evaluateFederalEvidence(input: {
  normalizedPhone: string;
  evidence: ContactComplianceEvidence;
  now: string;
}):
  | { kind: 'usable_clear' }
  | { kind: 'blocked'; reasonCode:
      | 'federal_status_unknown'
      | 'federal_dnc_listed'
      | 'federal_evidence_stale'
      | 'federal_area_code_mismatch'
      | 'tcpa_status_unknown'
      | 'tcpa_blocked' };
```

**Migration 0013 schema:**

Add to `person_contact_methods`:

```sql
federal_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (federal_status IN ('unknown', 'verified_clear', 'listed')),
compliance_tcpa_flag INTEGER NULL
  CHECK (compliance_tcpa_flag IS NULL OR compliance_tcpa_flag IN (0, 1)),
covered_area_code TEXT NULL
  CHECK (covered_area_code IS NULL OR covered_area_code GLOB '[0-9][0-9][0-9]'),
compliance_source TEXT NOT NULL DEFAULT 'legacy'
  CHECK (compliance_source IN ('ftc_download', 'enrichment_vendor', 'manual_import', 'legacy')),
scrubbed_at TEXT NULL,
compliance_expires_at TEXT NULL
```

Create:

```sql
CREATE TABLE contact_compliance_audit_events (
  id TEXT PRIMARY KEY,
  contact_method_id TEXT NOT NULL REFERENCES person_contact_methods(id),
  operation TEXT NOT NULL CHECK (operation IN ('intake_merge', 'authoritative_correction', 'legacy_backfill')),
  old_evidence_json TEXT NOT NULL,
  new_evidence_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ftc_download', 'enrichment_vendor', 'manual_import', 'legacy')),
  evidence_timestamp TEXT NULL,
  evidence_ref TEXT NULL,
  policy_version TEXT NOT NULL,
  resulting_reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX contact_compliance_audit_contact_idx
  ON contact_compliance_audit_events(contact_method_id, created_at, id);
```

Backfill rules:

- `dnc_listed = 1` becomes `federal_status = 'listed'`.
- `dnc_listed = 0` becomes `federal_status = 'unknown'`.
- `tcpa_flag = 1` becomes `compliance_tcpa_flag = 1`.
- `tcpa_flag = 0` becomes `compliance_tcpa_flag = NULL`.
- All legacy rows use `compliance_source = 'legacy'`, null coverage/scrub/expiry, and receive one `legacy_backfill` audit event.
- Keep `dnc_listed` and `tcpa_flag` columns as compatibility projections. New repository writes must set them from `compatibilityFlags`, never interpret `false` as clear.

**TDD tests:**

- `defaults a manual phone to explicit unknown evidence`
- `migrates a legacy negative boolean to unknown and null TCPA`
- `preserves a legacy DNC positive as listed`
- `preserves a legacy TCPA positive as blocked`
- `rejects invalid federal status, TCPA tri-state, and area-code values`
- `accepts verified clear only for a fresh matching area code`
- `rejects a verified-clear expiration more than 31 days after the scrub timestamp`
- `marks evidence refresh-due at 28 days without extending its authorization lifetime`
- `blocks unknown, listed, stale, wrong-area, TCPA-positive, and TCPA-unknown evidence`

- [ ] Write the failing migration and pure-evaluator tests.
- [ ] Run the focused tests and verify failures reference the missing migration/types/functions.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/contactCompliance.test.ts tests/main/db/migrations/0013ContactComplianceEvidence.test.ts
```

- [ ] Implement the migration, register schema version 13 after `0012UpstreamRequestState`, update `tests/main/migrations.test.ts` from schema 12 and migration IDs 0001–0012 to schema 13 and IDs 0001–0013, update Kysely row types, and update contact parsing/insertion.
- [ ] Run the focused tests, migration registry tests, and typecheck.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/contactCompliance.test.ts tests/main/db/migrations/0013ContactComplianceEvidence.test.ts tests/main/migrations.test.ts tests/main/domainSchema.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/domain/compliance/contactComplianceTypes.ts src/main/domain/compliance/contactCompliance.ts src/main/db/migrations/0013ContactComplianceEvidence.ts src/main/db/domainSchema.ts src/main/db/migrate.ts src/main/domain/identity/identityTypes.ts src/main/domain/identity/identityRepository.ts tests/main/contactCompliance.test.ts tests/main/db/migrations/0013ContactComplianceEvidence.test.ts tests/main/migrations.test.ts
git commit -m "feat: add explicit contact compliance evidence"
```

---

## Task 2: Fail-closed enrichment contracts and evidence mapping

**Files:**

- Modify `cloud/lambdas/enricher/src/enrich.ts`
- Modify `cloud/lambdas/enricher/test/enrich.test.ts`
- Modify `cloud/lambdas/shared/src/sourceEvent.ts`
- Modify `cloud/lambdas/shared/test/enrichment.test.ts`
- Modify `src/shared/contracts/cloudSourceEventContract.ts`
- Modify `tests/main/sourcing/cloudSourceEventContract.test.ts`
- Modify `src/main/sourcing/intakeMapper.ts`
- Modify `tests/main/sourcing/intakeMapper.test.ts`
- Modify fixtures in `tests/fixtures/cloudSourceEvents.ts`

**Wire interface:** Replace per-phone `dnc_listed: boolean` and `tcpa_flag: boolean` with:

```ts
compliance: z.object({
  federal_status: z.enum(['unknown', 'verified_clear', 'listed']),
  tcpa_flag: z.boolean().nullable(),
  covered_area_code: z.string().regex(/^\d{3}$/).nullable(),
  source: z.enum(['ftc_download', 'enrichment_vendor', 'manual_import', 'legacy']),
  scrubbed_at: z.string().datetime({ offset: true }).nullable(),
  expires_at: z.string().datetime({ offset: true }).nullable(),
}).strict()
```

**Mapping rule for the current Tracerfy shape:**

```ts
function vendorCompliance(phone: TracerfyPhone): ContactComplianceEvidence {
  return {
    federalStatus: phone.dnc === true ? 'listed' : 'unknown',
    tcpaFlag: phone.tcpa === true ? true : null,
    coveredAreaCode: null,
    source: 'enrichment_vendor',
    scrubbedAt: null,
    expiresAt: null,
  };
}
```

The app-side intake field name is locked for later plans:

```ts
export type IntakeContactInput = {
  kind: 'phone' | 'email';
  value: string;
  reachability: 'direct' | 'indirect' | 'none';
  isPrimary?: boolean;
  inContacts?: boolean | null;
  complianceEvidence?: ContactComplianceEvidence;
};
```

Phone intake defaults `complianceEvidence` to explicit legacy/manual unknown evidence when absent. Email intake leaves it undefined. The lead-review plan may add a separate `presentationEvidence` field, but must not rename or duplicate `complianceEvidence`.

A later authoritative FTC adapter may emit `verified_clear`, but this task must not synthesize clear evidence from absent/false vendor fields.

**TDD tests:**

- `maps missing vendor DNC and TCPA fields to unknown evidence`
- `maps vendor false DNC and TCPA fields to unknown evidence`
- `maps a positive DNC result to listed`
- `maps a positive TCPA result to true while federal remains unknown`
- `rejects verified_clear without coverage, scrub time, or expiry`
- `carries the exact evidence record through cloud and app contracts`

- [ ] Write failing tests in both packages.
- [ ] Run them and verify contract/mapping failures.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/enricher && npm test -- test/enrich.test.ts)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm test -- test/enrichment.test.ts)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/sourcing/cloudSourceEventContract.test.ts tests/main/sourcing/intakeMapper.test.ts
```

- [ ] Implement the strict mirrored contracts and fail-closed mapper.
- [ ] Run focused tests and package typechecks.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/enricher && npm run typecheck && npm test)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm run typecheck && npm test)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/sourcing/cloudSourceEventContract.test.ts tests/main/sourcing/intakeMapper.test.ts
```

- [ ] Commit.

```bash
git add cloud/lambdas/enricher/src/enrich.ts cloud/lambdas/enricher/test/enrich.test.ts cloud/lambdas/shared/src/sourceEvent.ts cloud/lambdas/shared/test/enrichment.test.ts src/shared/contracts/cloudSourceEventContract.ts tests/main/sourcing/cloudSourceEventContract.test.ts src/main/sourcing/intakeMapper.ts tests/main/sourcing/intakeMapper.test.ts tests/fixtures/cloudSourceEvents.ts
git commit -m "fix: map missing vendor compliance evidence to unknown"
```

---

## Task 3: Monotonic contact merge and audited correction command

**Files:**

- Create `src/main/domain/compliance/contactComplianceService.ts`
- Create `tests/main/contactComplianceService.test.ts`
- Modify `src/main/domain/compliance/contactCompliance.ts`
- Modify `src/main/domain/compliance/contactComplianceTypes.ts`
- Modify `src/main/domain/identity/identityRepository.ts`
- Modify `src/main/domain/source/sourceService.ts`
- Modify `src/main/domain/source/sourceTypes.ts`
- Modify `src/main/domain/createDomainServices.ts`
- Modify `tests/main/sourceService.test.ts`
- Modify `tests/main/sourcing/founderSalesDomainUpstream.test.ts`

**Interfaces:**

```ts
export type ComplianceMergeResult = Readonly<{
  evidence: ContactComplianceEvidence;
  changed: boolean;
  reasonCode: string;
}>;

export function mergeContactComplianceEvidence(input: {
  current: ContactComplianceEvidence;
  incoming: ContactComplianceEvidence;
  normalizedPhone: string;
  now: string;
}): ComplianceMergeResult;

export type CorrectContactComplianceEvidenceInput = Readonly<{
  contactMethodId: string;
  evidence: ContactComplianceEvidence;
  evidenceRef: string;
  correctionReason: string;
  correctedAt: string;
  policyVersion: 'contact_compliance_correction_v1';
}>;

export class ContactComplianceService {
  mergeFromIntake(input: {
    contactMethodId: string;
    incoming: ContactComplianceEvidence;
    evidenceRef: string | null;
    observedAt: string;
  }): ContactMethod;

  correctAuthoritatively(input: CorrectContactComplianceEvidenceInput): ContactMethod;
}
```

**Ordinary merge precedence:**

1. Existing or incoming person opt-out is outside this function and remains unconditional in the final service.
2. `listed` wins over every ordinary incoming state.
3. `tcpaFlag === true` wins over false/null.
4. Unknown/expired/wrong-area evidence remains blocked.
5. Fresh, covered `verified_clear` may replace only unknown/nonpositive evidence.
6. A fresh clear may never clear existing `listed` or `tcpaFlag === true` through `mergeFromIntake`.
7. `correctAuthoritatively` may clear a positive only with nonblank `evidenceRef`, nonblank correction reason, canonical timestamp, policy version, and a fully usable new evidence record. It appends `authoritative_correction` audit evidence in the same transaction.

**Existing-contact fix:** Replace `if (alreadyLinked) continue` in `SourceService.attachNewContacts` with:

- locate the exact existing `ContactMethod` for the same person/kind/normalized value;
- call `mergeFromIntake` even when the contact already exists;
- only call `addContactMethod` for a genuinely new contact;
- append old/new/source/timestamp audit data before the intake transaction commits;
- evaluate the resulting federal reason code inside the transaction and store it in the audit event. Do not store a reusable authorization boolean;
- after Task 4 introduces jurisdiction authorization, recompute current call and text decisions for the resulting contact inside this same transaction before commit and append their refusal reason codes to the audit event.

**TDD tests:**

- `upgrades an existing phone from unknown to listed on later intake`
- `upgrades an existing phone from unknown TCPA to positive`
- `allows fresh covered clear to replace unknown`
- `does not clear listed with later ordinary clear evidence`
- `does not clear TCPA positive with later ordinary false evidence`
- `authoritative correction clears a positive only with complete audited evidence`
- `rolls back contact update and audit event together on intake failure`
- `replaying the same intake receipt does not append another audit event`
- `recomputes the resulting federal refusal before the contact-upsert transaction commits`

- [ ] Write failing unit and source-service tests.
- [ ] Run focused tests and verify the existing `alreadyLinked` skip causes the later-hit test to fail.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/contactComplianceService.test.ts tests/main/sourceService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts
```

- [ ] Implement the pure merge, repository update with optimistic old-state predicates, audit insert, and correction command.
- [ ] Run focused and integration tests.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/contactCompliance.test.ts tests/main/contactComplianceService.test.ts tests/main/sourceService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts tests/integration/optOutPersistence.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/domain/compliance/contactComplianceService.ts src/main/domain/compliance/contactCompliance.ts src/main/domain/compliance/contactComplianceTypes.ts src/main/domain/identity/identityRepository.ts src/main/domain/source/sourceService.ts src/main/domain/source/sourceTypes.ts src/main/domain/createDomainServices.ts tests/main/contactComplianceService.test.ts tests/main/sourceService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts
git commit -m "fix: merge contact compliance evidence monotonically"
```

---

## Task 4: Recipient jurisdiction, state clearance, and recipient-local windows

**Files:**

- Create `src/main/db/migrations/0014OutboundJurisdictionClearance.ts`
- Create `tests/main/db/migrations/0014OutboundJurisdictionClearance.test.ts`
- Create `src/main/domain/compliance/jurisdictionRepository.ts`
- Create `tests/main/jurisdictionRepository.test.ts`
- Create `src/main/domain/compliance/outboundAuthorization.ts`
- Create `tests/main/outboundAuthorization.test.ts`
- Modify `src/main/domain/compliance/contactComplianceTypes.ts`
- Modify `src/main/domain/compliance/contactComplianceService.ts`
- Modify `src/main/domain/identity/identityRepository.ts`
- Modify `tests/main/contactComplianceService.test.ts`
- Modify `src/main/db/domainSchema.ts`
- Modify `src/main/db/migrate.ts`
- Modify `tests/main/migrations.test.ts`
- Modify `src/main/domain/createDomainServices.ts`
- Modify `src/main/domain/source/sourceService.ts`
- Modify `tests/main/sourceService.test.ts`
- Modify `tests/main/sourcing/founderSalesDomainUpstream.test.ts`

**Migration 0014 schema:**

```sql
CREATE TABLE person_outbound_jurisdictions (
  person_id TEXT PRIMARY KEY REFERENCES persons(id),
  region_code TEXT NOT NULL CHECK (region_code GLOB '[A-Z][A-Z]'),
  timezone TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('property_address', 'residence_evidence', 'manual_review')),
  evidence_ref TEXT NULL,
  effective_at TEXT NOT NULL,
  review_at TEXT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outbound_jurisdiction_clearances (
  region_code TEXT NOT NULL CHECK (region_code GLOB '[A-Z][A-Z]'),
  channel TEXT NOT NULL CHECK (channel IN ('call', 'text')),
  decision TEXT NOT NULL CHECK (decision IN ('unknown', 'allowed', 'blocked')),
  registration_confirmed INTEGER NULL CHECK (registration_confirmed IS NULL OR registration_confirmed IN (0, 1)),
  state_dnc_subscription_confirmed INTEGER NULL CHECK (state_dnc_subscription_confirmed IS NULL OR state_dnc_subscription_confirmed IN (0, 1)),
  consent_rule_confirmed INTEGER NULL CHECK (consent_rule_confirmed IS NULL OR consent_rule_confirmed IN (0, 1)),
  source TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  expires_at TEXT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (region_code, channel)
);

CREATE TABLE outbound_jurisdiction_audit_events (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('person_jurisdiction', 'state_clearance')),
  subject_key TEXT NOT NULL,
  old_value_json TEXT NULL,
  new_value_json TEXT NOT NULL,
  source TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE contact_compliance_audit_events
  ADD COLUMN resulting_call_reason_code TEXT NULL;
ALTER TABLE contact_compliance_audit_events
  ADD COLUMN resulting_text_reason_code TEXT NULL;
```

Seed fail-closed rows for `MA`, `RI`, and `CT` calls:

- MA: `decision = 'blocked'`.
- RI: `decision = 'unknown'`, registration/state-list/consent fields null.
- CT: `decision = 'unknown'`, registration/state-list/consent fields null.
- Source: `approved_design_2026_09_04`; effective time: `2026-09-04T00:00:00.000Z`.

Backfill `person_outbound_jurisdictions` only where a person has exactly one distinct nonblank property region. Normalize `Massachusetts -> MA`, `Rhode Island -> RI`, `Connecticut -> CT`; use `America/New_York`. Do not infer jurisdiction from a phone number. Multiple/no property regions remain absent and blocked.

**Pure evaluator interfaces:**

```ts
export type OutboundChannel = 'call' | 'text';
export type OutboundAuthorizationReasonCode =
  | 'person_or_handle_opted_out'
  | 'channel_contact_kind_mismatch'
  | 'contact_validation_unusable'
  | 'federal_status_unknown'
  | 'federal_dnc_listed'
  | 'federal_evidence_stale'
  | 'federal_area_code_mismatch'
  | 'tcpa_status_unknown'
  | 'tcpa_blocked'
  | 'jurisdiction_unknown'
  | 'jurisdiction_blocked'
  | 'state_registration_missing'
  | 'state_dnc_subscription_missing'
  | 'state_consent_rule_unknown'
  | 'outside_recipient_window';

export type OutboundAuthorizationDecision =
  | Readonly<{ kind: 'allowed' }>
  | Readonly<{ kind: 'refused'; reasonCode: OutboundAuthorizationReasonCode }>;

export function evaluateOutboundAuthorization(input: {
  channel: OutboundChannel;
  now: string;
  personOrHandleOptedOut: boolean;
  contact: {
    kind: 'phone' | 'email';
    normalizedValue: string;
    validationState: 'unverified' | 'valid' | 'invalid';
    evidence: ContactComplianceEvidence;
  };
  jurisdiction: {
    regionCode: string;
    timezone: string;
    reviewAt: string | null;
  } | null;
  clearance: {
    decision: 'unknown' | 'allowed' | 'blocked';
    registrationConfirmed: boolean | null;
    stateDncSubscriptionConfirmed: boolean | null;
    consentRuleConfirmed: boolean | null;
    effectiveAt: string;
    expiresAt: string | null;
  } | null;
  windows: ChannelPolicySnapshots;
}): OutboundAuthorizationDecision;

export type CallRecordingConsentEvidence = Readonly<{
  decision: 'unknown' | 'granted' | 'denied';
  source: string | null;
  evidenceRef: string | null;
  observedAt: string | null;
  expiresAt: string | null;
}>;

export type CallRecordingAuthorizationDecision =
  | Readonly<{ kind: 'allowed' }>
  | Readonly<{ kind: 'refused'; reasonCode:
      | 'recording_call_not_allowed'
      | 'recording_consent_unknown'
      | 'recording_consent_denied'
      | 'recording_consent_stale' }>;

export function evaluateCallRecordingAuthorization(input: {
  callDecision: OutboundAuthorizationDecision;
  consent: CallRecordingConsentEvidence | null;
  now: string;
}): CallRecordingAuthorizationDecision;
```

Reuse `FOUNDER_CHANNEL_POLICIES_V1` values but evaluate them in the recipient timezone. Treat the end minute as exclusive. Invalid/missing timezone, expired jurisdiction review, absent/expired clearance, and null required obligation fields fail closed. `consentRuleConfirmed` is a state outreach-rule field only. It is never recording consent. Recording remains refused unless the separate recording evaluator receives explicit, current consent evidence.

**TDD tests:**

- `does not infer recipient jurisdiction from the phone area code`
- `backfills one unambiguous property region and leaves conflicts unknown`
- `blocks MA calls under the seeded policy`
- `blocks RI and CT calls while obligations are unknown`
- `blocks missing and expired state clearance`
- `blocks missing registration, state DNC subscription, and consent decisions`
- `allows a fully cleared state inside the recipient-local call window`
- `refuses one millisecond before opening and at the exclusive closing boundary`
- `handles DST transitions in the recipient timezone without using host-local time`
- `does not treat an allowed call decision as recording consent`
- `refuses recording when call eligibility is allowed but recording consent is unknown`
- `allows recording only with a separately current granted consent decision`
- `recomputes call and text refusal reasons after contact evidence merge before commit`

- [ ] Write failing migration/repository/evaluator tests.
- [ ] Run focused tests.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/db/migrations/0014OutboundJurisdictionClearance.test.ts tests/main/jurisdictionRepository.test.ts tests/main/outboundAuthorization.test.ts tests/main/contactComplianceService.test.ts tests/main/sourceService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts
```

- [ ] Implement migration, strict repository, outbound evaluator, and separate recording evaluator. Update aggregate migration expectations from 13 to 14 and add 0014 to the exact migration list.
- [ ] Inject the outbound evaluator into the contact-upsert path. After the monotonic contact merge and audit append but before transaction commit, load current jurisdiction/clearance, compute call and text decisions from the resulting contact, and store only their refusal reason codes in the same audit event. A later handoff still re-evaluates from live state.
- [ ] Run focused tests, cadence-window regressions, migration suite, and typecheck.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/db/migrations/0014OutboundJurisdictionClearance.test.ts tests/main/jurisdictionRepository.test.ts tests/main/outboundAuthorization.test.ts tests/main/contactComplianceService.test.ts tests/main/sourceService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts tests/main/cadenceScheduler.test.ts tests/main/migrations.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/db/migrations/0014OutboundJurisdictionClearance.ts src/main/db/domainSchema.ts src/main/db/migrate.ts tests/main/migrations.test.ts src/main/domain/compliance/jurisdictionRepository.ts src/main/domain/compliance/outboundAuthorization.ts src/main/domain/compliance/contactComplianceTypes.ts src/main/domain/compliance/contactComplianceService.ts src/main/domain/identity/identityRepository.ts src/main/domain/createDomainServices.ts src/main/domain/source/sourceService.ts tests/main/contactComplianceService.test.ts tests/main/sourceService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts tests/main/db/migrations/0014OutboundJurisdictionClearance.test.ts tests/main/jurisdictionRepository.test.ts tests/main/outboundAuthorization.test.ts
git commit -m "feat: add fail-closed jurisdiction authorization"
```

---

## Task 5: One final outbound authorization service at the activity handoff

**Files:**

- Modify `src/main/domain/optOut/outboundPermissionService.ts`
- Modify `src/main/domain/optOut/optOutTypes.ts`
- Modify `src/main/domain/support/domainErrors.ts`
- Modify `src/main/domain/createDomainServices.ts`
- Modify `src/main/domain/founderSalesDomain.ts`
- Modify `tests/main/outboundPermissionService.test.ts`
- Modify `tests/integration/leadDetailService.test.ts`
- Modify `tests/main/sourcing/founderSalesDomainUpstream.test.ts`

**Service interface:**

```ts
export class OutboundPermissionService {
  inspectOutbound(input: {
    personId: string;
    contactMethodId: string;
    channel: 'call' | 'text';
    now: string;
  }): OutboundAuthorizationDecision;

  assertMayExecuteOutbound(input: {
    personId: string;
    contactMethodId: string;
    channel: 'call' | 'text';
    now: string;
  }): void;
}

export class OutboundAuthorizationError extends Error {
  readonly reasonCode: OutboundAuthorizationReasonCode;
  constructor(reasonCode: OutboundAuthorizationReasonCode);
}
```

`inspectPerson` and `assertMayContactHandle` remain available for prioritization/opt-out callers. `assertMayExecuteOutbound` becomes the sole call/text final gate and loads all current state by IDs itself. It must not accept renderer-supplied evidence, jurisdiction, or clearance.

**`FounderSalesDomain.beginOutbound` sequence:**

1. Parse request and read `now` once.
2. Begin the existing immediate transaction.
3. Load and bind the cycle/person/contact.
4. Verify contact kind matches the channel: call/text require `phone`; email requires `email`.
5. For call/text, invoke `assertMayExecuteOutbound({personId, contactMethodId, channel, now})`.
6. For email, preserve permanent person/handle opt-out and validation checks, but do not apply phone DNC/TCPA logic.
7. Immediately call `events.appendActivity`. No other mutable read or async boundary may occur between authorization and append.
8. Store only `authorizationPolicyVersion: 'outbound_compliance_v1'` and `authorizationReason: 'allowed'` in activity metadata. Never log the contact value or evidence record.

Delete the duplicate boolean DNC/TCPA branch at `src/main/domain/founderSalesDomain.ts:845-852`; the explicit gate owns the decision.

**TDD tests:**

- `returns stable refusal codes for every explicit gate`
- `rejects a phone contact used for email and an email used for call or text`
- `rejects invalid and unverified contact methods`
- `re-reads evidence immediately before appendActivity`
- `does not append activity when authorization refuses`
- `rolls back the outbound activity if the authorization transaction fails`
- `authorizes the exact selected contact rather than another clear phone on the person`
- `preserves permanent opt-out precedence over every other reason`
- `runs final authorization after cycle/contact ownership checks and immediately before appendActivity`

For the final-order test, inject a test-only event-repository spy or fault hook and assert the call order is exactly `load current state -> authorize -> appendActivity`; also mutate evidence between an earlier detail read and `beginOutbound` and prove the command refuses.

- [ ] Write failing service and integration tests.
- [ ] Run them and confirm current code incorrectly permits unknown/legacy contacts.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/outboundPermissionService.test.ts tests/integration/leadDetailService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts
```

- [ ] Implement the centralized service and exact beginOutbound ordering.
- [ ] Run focused tests and the Today call-flow regression.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/outboundPermissionService.test.ts tests/integration/leadDetailService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts tests/integration/todayCallFlow.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/domain/optOut/outboundPermissionService.ts src/main/domain/optOut/optOutTypes.ts src/main/domain/support/domainErrors.ts src/main/domain/createDomainServices.ts src/main/domain/founderSalesDomain.ts tests/main/outboundPermissionService.test.ts tests/integration/leadDetailService.test.ts tests/main/sourcing/founderSalesDomainUpstream.test.ts
git commit -m "fix: enforce final outbound authorization at handoff"
```

---

## Task 6: Explicit phone compliance status in the renderer

**Files:**

- Modify `src/shared/contracts/leadDetailContract.ts`
- Modify `src/main/domain/founderSalesDomain.ts`
- Modify `src/renderer/features/leadInspector/InspectorOverview.tsx`
- Modify `src/renderer/features/leadInspector/LeadInspector.test.tsx`
- Modify `src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx`
- Modify `tests/integration/leadDetailService.test.ts`

**Contract:**

```ts
export const phoneComplianceStatusSchema = z.enum([
  'verified_clear',
  'federal_dnc_listed',
  'tcpa_blocked',
  'compliance_unknown',
  'scrub_expired',
  'area_code_not_covered',
  'state_clearance_required',
  'outside_recipient_window',
]);

export const contactMethodSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['phone', 'email']),
  value: z.string().min(1),
  label: z.string().nullable(),
  valid: z.boolean(),
  compliance: z.object({
    status: phoneComplianceStatusSchema,
    label: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    callRefusalReason: outboundAuthorizationReasonCodeSchema.nullable(),
    textRefusalReason: outboundAuthorizationReasonCodeSchema.nullable(),
  }).strict().nullable(),
}).strict();
```

Email contacts have `compliance: null`. Phone labels are exact:

- `Verified clear until <date>`
- `Federal DNC listed`
- `TCPA blocked`
- `Compliance unknown`
- `Scrub expired`
- `Area code not covered`
- `State clearance required`
- `Outside recipient calling window`

The detail read is advisory only. It may enable a button when currently allowed, but `beginOutbound` still repeats the final gate.

**TDD tests:**

- `renders each explicit phone compliance label`
- `disables call and text for every status except verified clear with state clearance inside the current window`
- `uses the stable refusal reason as accessible disabled-control help text`
- `never exposes source JSON, contact HMAC, evidence reference, or policy internals`
- `still handles a final-gate refusal after an allowed detail snapshot`

- [ ] Write failing contract, integration, and renderer tests.
- [ ] Run focused tests.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- src/renderer/features/leadInspector/LeadInspector.test.tsx src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx tests/integration/leadDetailService.test.ts
```

- [ ] Implement explicit projection and accessible disabled reasons; remove renderer use of `dncListed`/`tcpaFlag`.
- [ ] Run focused tests and typecheck.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- src/renderer/features/leadInspector/LeadInspector.test.tsx src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx tests/integration/leadDetailService.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/shared/contracts/leadDetailContract.ts src/main/domain/founderSalesDomain.ts src/renderer/features/leadInspector/InspectorOverview.tsx src/renderer/features/leadInspector/LeadInspector.test.tsx src/renderer/features/leadInspector/LeadInspectorProvider.test.tsx tests/integration/leadDetailService.test.ts
git commit -m "feat: show explicit outbound compliance refusals"
```

---

## Task 7: Immutable local suppression object keys

**Files:**

- Modify `src/main/sourcing/upstreamSync.ts`
- Modify `src/main/startApplication.ts`
- Modify `tests/main/sourcing/upstreamSync.test.ts`
- Modify path comments in `src/shared/contracts/suppressionUploadContract.ts`
- Modify path comments in `cloud/lambdas/shared/src/suppressionUpload.ts`

**Interfaces:**

```ts
export const UPSTREAM_SUPPRESSIONS_PREFIX = 'upstream/suppression/';

export type UpstreamBatchIdGenerator = {
  next(): string;
};

export function suppressionObjectKey(input: {
  now: string;
  batchId: string;
}): string;
// upstream/suppression/2026-09-04/20260904T154923599Z-<sanitized-batch-id>.ndjson

export class UpstreamSync {
  constructor(input: {
    domainGate: UpstreamSyncDomainGate;
    loadHmacSalt: () => Promise<string | null>;
    clock: Clock;
    batchIds: UpstreamBatchIdGenerator;
  });
}
```

Generate a key only after reading a nonempty suppression batch and before uploading. Mark exactly those handle IDs flushed only after that immutable put succeeds. A retry after an ambiguous S3 response may create a second immutable object; cloud processing is membership-idempotent and must process both.

**TDD tests:**

- `uses distinct immutable keys for two suppression uploads on the same day`
- `includes UTC timestamp and batch ID under the singular suppression prefix`
- `never reuses a key after clock advancement or retry`
- `does not mark handles flushed when the put fails`
- `marks only the uploaded handle IDs after success`
- `contains no cleartext contact values in the key or body`

- [ ] Write failing tests.
- [ ] Run focused tests and confirm current date-derived key reuse fails.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/sourcing/upstreamSync.test.ts tests/main/suppressionOutbox.test.ts
```

- [ ] Implement immutable key generation and production ID wiring in `src/main/startApplication.ts`.
- [ ] Run focused tests and typecheck.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test -- tests/main/sourcing/upstreamSync.test.ts tests/main/suppressionOutbox.test.ts
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
```

- [ ] Commit.

```bash
git add src/main/sourcing/upstreamSync.ts src/main/startApplication.ts tests/main/sourcing/upstreamSync.test.ts src/shared/contracts/suppressionUploadContract.ts cloud/lambdas/shared/src/suppressionUpload.ts
git commit -m "fix: upload suppressions with immutable object keys"
```

---

## Task 8: Version-aware suppression identity and whole-object validation

**Files:**

- Create `cloud/lambdas/suppression-sync/src/suppressionObject.ts`
- Create `cloud/lambdas/suppression-sync/test/suppressionObject.test.ts`
- Modify `cloud/lambdas/suppression-sync/src/handler.ts`
- Modify `cloud/lambdas/suppression-sync/test/handler.test.ts`

**Interfaces:**

```ts
export type SuppressionObjectDescriptor = Readonly<{
  bucket: string;
  key: string;
  versionId: string | null;
  etag: string;
  lastModified: string;
}>;

export type ValidatedSuppressionObject = Readonly<{
  descriptor: SuppressionObjectDescriptor;
  checksumSha256: string;
  lines: readonly SuppressionUploadLine[];
  validRowCount: number;
}>;

export class SuppressionObjectValidationError extends Error {
  readonly key: string;
  readonly versionId: string | null;
  readonly invalidLineNumbers: readonly number[];
}

export function parseAndValidateSuppressionObject(input: {
  descriptor: SuppressionObjectDescriptor;
  text: string;
}): ValidatedSuppressionObject;

export function ledgerNaturalKey(object: ValidatedSuppressionObject): string;
```

**Cloud behavior:**

- Replace `ListObjectsV2Command` with `ListObjectVersionsCommand` under `upstream/suppression/`.
- Fetch each version with `GetObjectCommand({Bucket, Key, VersionId})`.
- Normalize ETags by removing surrounding quotes but retaining exact content.
- Compute SHA-256 over the exact UTF-8 object body.
- Validate every nonblank line first. If any fails, throw `SuppressionObjectValidationError`, log `{key, version_id, invalid_line_numbers, invalid_line_count}` without row content, write no suppression item, write no ledger item, and let the Lambda invocation fail.
- Ledger identity is a collision-safe SHA-256 of canonical `{bucket,key,versionId,etag,checksumSha256}`. The item also records each field, `processed_at`, `valid_row_count`, and `object_checksum_sha256`.
- A hit requires an item whose stored bucket/key/version/ETag/checksum all equal the current descriptor. Do not treat key-only records as hits.
- Validate before checking/marking completion if checksum is not already known. This intentionally reads the object before the exact ledger lookup.
- Write suppression memberships after validation. If a write fails, no ledger marker is written; retry is idempotent because `contact_hash` is the membership key.

**TDD tests:**

- `processes two same-day immutable objects`
- `processes two versions of the same legacy key`
- `does not accept a key-only legacy ledger record as an exact hit`
- `requires matching key version ETag and checksum for a ledger hit`
- `records bucket key version ETag checksum timestamp and valid row count`
- `fails the entire object on one malformed row before the first suppression write`
- `reports exact invalid line numbers without logging contact data`
- `does not ledger an object when validation or a suppression write fails`
- `replaying the exact same object identity is idempotent`

- [ ] Write failing parser and handler tests using fakes that preserve VersionId, ETag, LastModified, command order, and ledger item attributes.
- [ ] Run focused package tests.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/suppression-sync && npm test -- test/suppressionObject.test.ts test/handler.test.ts)
```

- [ ] Implement exact object identity, whole-object validation, and failure behavior.
- [ ] Run all package tests, typecheck, and build.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/suppression-sync && npm run typecheck && npm test && npm run build)
```

- [ ] Commit.

```bash
git add cloud/lambdas/suppression-sync/src/suppressionObject.ts cloud/lambdas/suppression-sync/src/handler.ts cloud/lambdas/suppression-sync/test/suppressionObject.test.ts cloud/lambdas/suppression-sync/test/handler.test.ts
git commit -m "fix: validate and ledger exact suppression object versions"
```

---

## Task 9: Historical replay, quarantine, reconciliation, retention, and alarms

**Files:**

- Create `cloud/lambdas/suppression-sync/src/replay.ts`
- Create `cloud/lambdas/suppression-sync/test/replay.test.ts`
- Modify `cloud/lambdas/suppression-sync/src/handler.ts`
- Modify `cloud/lambdas/suppression-sync/test/handler.test.ts`
- Modify `cloud/terraform/iam.tf`
- Modify `cloud/terraform/s3.tf`
- Modify `cloud/terraform/alarms.tf`
- Modify `cloud/terraform/adapters.tf`

**Handler modes:**

```ts
export type SuppressionSyncEvent =
  | { mode?: 'incremental'; maxObjects?: number }
  | { mode: 'replay'; dryRun: boolean }
  | { mode: 'reconcile'; reportKey: string };

export type SuppressionReplayReport = Readonly<{
  generatedAt: string;
  objectsSeen: number;
  objectsValid: number;
  objectsQuarantined: number;
  uniqueMemberships: number;
  appliedMemberships: number;
  missingMemberships: number;
  unexpectedMemberships: number;
  sourceUnionChecksumSha256: string;
  quarantine: ReadonlyArray<{
    key: string;
    versionId: string | null;
    invalidLineNumbers: readonly number[];
  }>;
}>;

export type SuppressionReplayResult = Readonly<{
  reportKey: string;
  report: SuppressionReplayReport;
}>;
```

**Replay order and safety:**

- Sort all retained versions by `LastModified`, then `Key`, then `VersionId` for deterministic version order.
- Parse every version. Invalid versions are quarantined in the report and are not ledgered.
- Replay may continue past quarantined historical versions only in explicit `mode: 'replay'`; normal incremental mode still fails its invocation on an invalid object.
- Build the union by `contact_hmac`. For duplicate hashes, preserve the earliest `observed_at` and strongest reason using `opt_out > founder_block > wrong_person`; membership itself never clears.
- Apply union items idempotently.
- Reconcile the source union against DynamoDB using `BatchGetItem` in chunks of 100. `unexpectedMemberships` requires a table scan and must be included before re-enable; add `dynamodb:Scan` only to this Lambda role.
- Generate one ULID `runId` at invocation start and write the dated JSON evidence report to `upstream/suppression-reports/YYYY-MM-DD/<timestamp>-<runId>.json`. It contains counts, object identities, checksums, and invalid line numbers, never contact HMACs or row bodies.
- Write with `IfNoneMatch: '*'` and fail on collision. Return the exact `reportKey` in every replay result. Reconciliation accepts only that returned key and never synthesizes a date-based or fixed filename.

**Infrastructure changes:**

- `cloud/terraform/iam.tf`: add `s3:ListBucketVersions`, `s3:GetObjectVersion`, report `s3:PutObject`, `dynamodb:BatchGetItem`, and `dynamodb:Scan` for the suppression-sync role.
- `cloud/terraform/s3.tf`: remove the blanket 30-day noncurrent-version expiry or otherwise exempt suppression objects. Given the current single inbox bucket and no object tagging, the precise safe implementation is to retain noncurrent versions globally until a dedicated suppression bucket/tagging design exists. Keep incomplete-multipart cleanup.
- `cloud/terraform/alarms.tf`: add a dedicated `${var.name_prefix}-suppression-sync-errors` Lambda `Errors >= 1` alarm with 300-second period, one evaluation period, SNS alert and OK actions.
- `cloud/terraform/adapters.tf`: keep schedules governed by `var.schedules_enabled`; do not enable them in the code commit.

**TDD tests:**

- `replays every retained version in deterministic version order`
- `builds the union of person and contact tombstones idempotently`
- `quarantines invalid historical versions without ledgering them`
- `incremental mode still fails on an invalid current object`
- `reports missing and unexpected cloud memberships`
- `writes a dated immutable evidence report without HMACs or row content`
- `two replay runs at the same clock instant produce distinct immutable report keys`
- `reconciliation accepts the exact report key returned by replay`
- `a second replay produces the same source union checksum and no new memberships`

- [ ] Write failing replay tests.
- [ ] Run package tests.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/suppression-sync && npm test -- test/replay.test.ts test/handler.test.ts)
```

- [ ] Implement replay and reconciliation.
- [ ] Run package verification and build.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/suppression-sync && npm run typecheck && npm test && npm run build)
```

- [ ] Validate infrastructure formatting and plan while schedules remain disabled.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";
cd cloud/terraform
tofu fmt -check
tofu validate
tofu plan -var='schedules_enabled=false' -out="$JCODE_SCRATCH_DIR/compliance-task9.tfplan"
tofu show -no-color "$JCODE_SCRATCH_DIR/compliance-task9.tfplan"
```

Expected plan properties:

- no schedule is enabled;
- suppression-sync gets version-read, report-write, batch-get, and scan permissions only for required resources;
- noncurrent suppression versions are retained;
- a dedicated suppression-sync error alarm is created;
- no DynamoDB table is destroyed or replaced.

- [ ] Commit.

```bash
git add cloud/lambdas/suppression-sync/src/replay.ts cloud/lambdas/suppression-sync/src/handler.ts cloud/lambdas/suppression-sync/test/replay.test.ts cloud/lambdas/suppression-sync/test/handler.test.ts cloud/terraform/iam.tf cloud/terraform/s3.tf cloud/terraform/alarms.tf cloud/terraform/adapters.tf
git commit -m "feat: replay and reconcile suppression history"
```

---

## Task 10: Full verification, packaged-app acceptance, and controlled rollout

**Cross-plan prerequisite:** Complete runtime/recovery Tasks 1–12 after this plan's schema-13/14 Tasks 1–9 and before this Task 10. That provides the tracked-source lint, secret scan, backup, observability, and exact-SHA package gates used below. Runtime Task 13 runs after this controlled compliance rollout.

**Files:**

- Add or modify `tests/e2e/founderWorkflow.spec.ts` for packaged UI refusal/allowed states.
- Add the dated operational evidence report at `docs/sourcing/founder-actions/2026-09-04-outbound-compliance-rollout.md`. Do not commit contact values, HMACs, credentials, bucket account IDs, Terraform state, or private scratch artifacts.

**Automated acceptance cases:**

- missing vendor fields produce unknown and blocked;
- manual and migrated legacy contacts are blocked without evidence;
- later DNC/TCPA hits strengthen an existing contact;
- ordinary later clear evidence cannot clear a positive block;
- exact authoritative correction can clear only with audited evidence;
- two same-day suppression uploads are both processed;
- malformed row prevents all writes and ledger completion for that object;
- exact immutable object replay is idempotent;
- stale/wrong-area evidence is refused;
- missing/blocked/expired state clearance is refused;
- outside recipient-local window is refused;
- exact selected contact is authorized;
- evidence changed after UI render is refused by the final gate;
- permanent opt-out always wins;
- packaged UI disables controls and explains stable refusal reasons.

- [ ] Run root verification through the repaired tracked-source gate.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run typecheck
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run lint:tracked
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm test
```

- [ ] Run all affected Lambda packages.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/shared && npm run typecheck && npm test)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/enricher && npm run typecheck && npm test && npm run build)
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/lambdas/suppression-sync && npm run typecheck && npm test && npm run build)
```

- [ ] Package and run end-to-end acceptance with outreach still paused.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:package
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run test:e2e
```

- [ ] Create and apply a fresh reviewed infrastructure plan with `schedules_enabled=false`. The apply must deploy the exact built `enricher` plus shared-contract artifact and the exact built `suppression-sync` artifact, not only IAM/alarm changes.

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; (cd cloud/terraform && tofu init && tofu plan -var='schedules_enabled=false' -out="$JCODE_SCRATCH_DIR/compliance-rollout.tfplan" && tofu show -no-color "$JCODE_SCRATCH_DIR/compliance-rollout.tfplan" && tofu apply "$JCODE_SCRATCH_DIR/compliance-rollout.tfplan")
```

- [ ] Before invoking replay, compare each deployed Lambda `CodeSha256` with the base64 SHA-256 of the exact ZIP referenced by the reviewed Terraform plan. Record function name, code hash, and source commit only. Do not proceed if either hash differs.
- [ ] Invoke replay dry run and retain the returned report.

```bash
aws lambda invoke \
  --function-name callie-sourcing-suppression-sync \
  --cli-binary-format raw-in-base64-out \
  --payload '{"mode":"replay","dryRun":true}' \
  "$JCODE_SCRATCH_DIR/suppression-replay-dry-run.json"
```

- [ ] Repair or explicitly disposition every quarantined historical version. Do not enable enrichment with an unexplained invalid version.
- [ ] Invoke live replay, then reconcile and save the immutable evidence report key.

```bash
aws lambda invoke \
  --function-name callie-sourcing-suppression-sync \
  --cli-binary-format raw-in-base64-out \
  --payload '{"mode":"replay","dryRun":false}' \
  "$JCODE_SCRATCH_DIR/suppression-replay-live.json"

REPORT_KEY="$(python3 - "$JCODE_SCRATCH_DIR/suppression-replay-live.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding='utf-8'))
key = value.get('reportKey')
if not isinstance(key, str) or not key.startswith('upstream/suppression-reports/'):
    raise SystemExit('live replay did not return an immutable reportKey')
print(key)
PY
)"
RECONCILE_PAYLOAD="$(REPORT_KEY="$REPORT_KEY" python3 -c 'import json, os; print(json.dumps({"mode":"reconcile","reportKey":os.environ["REPORT_KEY"]}, separators=(",",":")))')"

aws lambda invoke \
  --function-name callie-sourcing-suppression-sync \
  --cli-binary-format raw-in-base64-out \
  --payload "$RECONCILE_PAYLOAD" \
  "$JCODE_SCRATCH_DIR/suppression-reconcile.json"
```

**Required reconciliation result:** `objectsQuarantined = 0`, `missingMemberships = 0`, `unexpectedMemberships = 0`, alarm state `OK`, and the source union checksum retained in the dated report.

- [ ] Verify representative production-safe records in the packaged app:
  - manual/legacy unknown phone: disabled and refused;
  - listed phone: disabled and refused;
  - TCPA-positive phone: disabled and refused;
  - stale/wrong-area clear phone: disabled and refused;
  - MA/RI/CT unresolved phone: disabled and refused;
  - test fixture with fresh covered evidence, explicit allowed state clearance, and in-window time: enabled and activity append succeeds;
  - mutate the test fixture to blocked after rendering and before click: final command refuses and no activity is appended.
- [ ] Enable `suppression-sync` first and observe one successful scheduled cycle and alarm state `OK`.
- [ ] Enable `enricher` only after suppression reconciliation remains exact and its deployed `CodeSha256` still matches the verified fail-closed build.
- [ ] Keep founder prospect outreach paused until the packaged-app final-gate checks above are signed off.
- [ ] Resume outreach only through a separate operational approval. Passing this implementation plan is not itself authorization to contact prospects.

- [ ] Commit only the final automated test additions and non-sensitive verification documentation.

```bash
git add tests/e2e/founderWorkflow.spec.ts docs/sourcing/founder-actions/2026-09-04-outbound-compliance-rollout.md
git commit -m "test: verify outbound compliance rollout gates"
```

---

## Logical commit sequence

1. `feat: add explicit contact compliance evidence`
2. `fix: map missing vendor compliance evidence to unknown`
3. `fix: merge contact compliance evidence monotonically`
4. `feat: add fail-closed jurisdiction authorization`
5. `fix: enforce final outbound authorization at handoff`
6. `feat: show explicit outbound compliance refusals`
7. `fix: upload suppressions with immutable object keys`
8. `fix: validate and ledger exact suppression object versions`
9. `feat: replay and reconcile suppression history`
10. `test: verify outbound compliance rollout gates`

Each commit has a focused failing test first, leaves schedules disabled, and is independently reviewable. Do not squash migration commits after deployment.

## Read-only findings that drive this plan

- `src/main/db/migrations/0011ContactDncFlags.ts:12-19` defaults missing/legacy evidence to boolean false.
- `cloud/lambdas/enricher/src/enrich.ts:90-95` converts missing vendor fields to false.
- `src/main/domain/source/sourceService.ts:579-604` skips compliance updates when a normalized handle is already linked.
- `src/main/sourcing/upstreamSync.ts:36-38` uses the plural suppression prefix, and the current date-derived upload path can be reused on the same day.
- `cloud/lambdas/suppression-sync/src/handler.ts:68-99` ledgers only by S3 key.
- `cloud/lambdas/suppression-sync/src/handler.ts:126-148` counts and skips malformed rows.
- `cloud/lambdas/suppression-sync/src/handler.ts:195-207` still writes valid rows and marks a malformed object processed.
- `cloud/terraform/s3.tf:88-110` expires every noncurrent inbox version after 30 days, which conflicts with indefinite suppression replayability.
- `cloud/terraform/iam.tf:237-264` lacks S3 version-read and reconciliation permissions.
- `src/main/domain/founderSalesDomain.ts:820-866` is the final app-side outbound activity handoff, but its gate only checks opt-out plus positive booleans.
- `src/renderer/features/leadInspector/InspectorOverview.tsx:58-87` disables only positive DNC/TCPA booleans and treats unknown as callable.
- No production call placement or message-send command exists in this worktree. `beginOutbound` records the founder-initiated outbound activity; the Apple bridge currently observes calls rather than initiating them. The final gate must therefore sit immediately before that append-only handoff and must remain in place when a future communications adapter is added.

## Implementation risks and explicit decisions

- **No authoritative clear source exists in current code.** This plan intentionally blocks current vendor-negative, manual, and legacy records rather than inventing scrub freshness. Outreach cannot resume until fresh covered evidence is loaded through an authoritative path.
- **Historical S3 versions may already have expired.** The existing 30-day lifecycle means replay can cover only retained versions. Record the earliest retained version and treat any unrecoverable interval as an operational compliance gap requiring manual source reconstruction before re-enable.
- **Jurisdiction evidence may be ambiguous.** Only a single unambiguous property region is backfilled. Absence or conflict stays blocked.
- **MA/RI/CT legal obligations are unresolved.** Seed blocked/unknown controls exactly as the approved design requires. A later legal decision must use audited clearance updates, not a code shortcut.
- **UI authorization is advisory.** Time and evidence can change after render. Only the transaction-time service decision authorizes the activity append.


## Plan self-review result

- Tasks 1 and 4 each own the matching `tests/main/migrations.test.ts` update, so aggregate expectations advance 12→13→14 in the same commits as their migrations.
- Contact upsert recomputes federal and channel-specific refusal reasons before commit, while the final handoff still re-evaluates live state.
- Call-recording consent has a separate fail-closed evaluator and is never inferred from state outreach clearance or an allowed call.
- Replay returns a ULID-qualified immutable report key; rollout passes that exact key to reconciliation and verifies both enricher and suppression-sync code hashes before schedule re-enable.
- `cloud/lambdas/shared/package.json` has no `build` script, so Task 10 runs only its `typecheck` and `test` scripts.
- Every `npm` or `npx` command begins with the exact required Node 24 PATH export.
- Migration ownership is explicit: this plan owns schema 13 and 14; the runtime plan owns 15; the lead-review plan owns 16.
- Operational schedule changes, historical replay, and outreach re-enable remain explicit hold points rather than implicit implementation steps.
