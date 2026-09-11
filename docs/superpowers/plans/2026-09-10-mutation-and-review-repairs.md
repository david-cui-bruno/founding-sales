# FSS Mutation Scope and Honest Review Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Repair the demonstrated shared-company mutation and stop advertising unsupported review/privacy actions or unmeasured health success.

**Architecture:** Keep the existing domain transaction and renderer contracts. Treat organization editing as assigning the selected prospect to a unique company identity, never renaming a shared company. Keep the actual Inbox resolver closed to unsupported commands and make its UI reflect that capability.

**Tech Stack:** TypeScript, React, Vitest, SQLite multiple ciphers, Node 24.20.0.

**Spec:** [Approved adversarial audit](../../engineering/2026-09-10-adversarial-product-audit.md), F01/F04 and copy portion of F05, approved 2026-09-10 03:04 UTC. [Program constraints and subsequent stages](../2026-09-10-product-repair-program.md).

## Global Constraints

- No broad rollback, history deletion, schema downgrade, suppression bypass, invented contact identity, inferred direct route, or weakened recovery/authority checks.
- Source and tests may change locally. Installation, real-profile operations, provider grants, calls/messages/calendar writes, deployment and push remain separately gated.
- Prefix every npm/npx command with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"`.
- No native rebuilds. Encrypted tests require the parent's sole test lease, run one worker with a dedicated scratch TMPDIR. No full/browser/Swift/package jobs in workers.
- Preserve existing public request/receipt contracts, schema and transaction atomicity. Only task-owned files may change. No subagents in workers.
- First run behavioral regressions against current production code, record meaningful RED, then implement minimal repair and run focused GREEN. Do not claim a source inspection is runtime acceptance.
- Freeze exact owned hashes and report before the coordinator authorizes an isolated commit.

---

### Task 1: Assign one person's organization without renaming shared identity

**Files:**
- Modify: `src/main/domain/founderSalesDomain.ts`, `applyLeadField` organization branch and a private helper if needed.
- Test: `tests/integration/leadsService.test.ts`.
- Test: `tests/integration/leadOrganizationAssignment.test.ts` for genuine CSV intake and stronger identity-preservation cases.

**Interfaces:**
- Consume unchanged `LeadFieldUpdateRequest`, `LeadBulkUpdateRequest`, `DomainServices.identities`, `DomainUnitOfWork.immediate`.
- Produce unchanged `MutationReceipt`, with only selected people/cycles affected because no shared organization row is mutated.
- Public methods remain `updateLeadField(input)` and `bulkUpdateLeads(input)`. No global rename operation is introduced.

**Decisions:**
- A value assigns the selected prospect to exactly one uniquely resolved organization. Null removes that prospect's sole organization link only. Shared organization rows, aliases, other prospects, properties, source receipts, and historical records remain intact.
- Zero existing links permits a new assignment. More than one existing organization link is ambiguous: fail before writes rather than choosing the first or deleting all relationships.
- Target matching uses the existing intake normalization semantics: `value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()`. Match distinct organization IDs by normalized alias and existing canonical name, including legacy organizations without aliases. Multiple matching IDs are ambiguous and must fail without writes.
- An unchanged unique target is a no-op for identities/links. New targets get a normalized alias so later normal intake and assignment reuse them. New target relationships do not inherit an unverified role from the old company.
- Reject whitespace-only non-null input consistently before writes. Do not invent an identity for empty input. UI already uses null for clearing.
- Expose a fixed non-sensitive ambiguity error through the existing error mechanism. Do not include names, raw rows or paths in errors.

- [ ] **Step 1: Add real-domain failing regressions.** In the existing `leadsService` fixture use the real `domain`, `services`, `database`, and `seedLead` helpers. The minimum independent shared-company oracle is:

```typescript
const alice = seedLead('alice');
const bob = seedLead('bob');
services.unitOfWork.immediate(() => {
  const shared = services.identities.createOrganization({ canonicalName: 'Shared Org' });
  services.identities.addOrganizationAlias({ organizationId: shared.id, alias: 'shared org' });
  services.identities.linkOrganization({ prospectId: alice.prospectId, organizationId: shared.id });
  services.identities.linkOrganization({ prospectId: bob.prospectId, organizationId: shared.id });
});
const receipt = domain.updateLeadField({
  personId: alice.personId, field: 'organization_label', value: 'New Employer',
});
const page = domain.listLeadRows({
  query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 200,
});
expect(page.rows.find((row) => row.personId === alice.personId)?.organization).toBe('New Employer');
expect(page.rows.find((row) => row.personId === bob.personId)?.organization).toBe('Shared Org');
expect(receipt.affectedPersonIds).toEqual([alice.personId]);
```

Add the same case through actual CSV preview/commit using the existing `tests/integration/importService.test.ts` setup, not test SQL pretending to prove intake. Assert the unrelated control remains unchanged and saved shared identity/alias/property/source rows remain byte-equivalent. Keep this test helper local to the test file.

- [ ] **Step 2: Run RED with the native lease.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run tests/integration/leadOrganizationAssignment.test.ts tests/integration/leadsService.test.ts --maxWorkers=1 --minWorkers=1
```

Expected meaningful failure: Bob is `New Employer` when literal expected value is `Shared Org`. Preserve the log. Fix a broken test setup before interpreting its failure.

- [ ] **Step 3: Implement transactional assignment.** Replace shared `UPDATE organizations SET canonical_name` with resolution before mutation, a new or reused target, and deletion/insertion of only the selected prospect's sole link. Equivalent control flow:

```typescript
// Executed inside the existing immediate unit of work.
// Load at most two current links. Refuse ambiguous current membership.
// Resolve unique target using canonical/alias normalization before changing links.
// If the unique target equals the current link, return without identity writes.
// For a new target, create organization and normalized alias through identities.
// Remove only the selected prospect's old link, then link the target with no inferred role.
// Null removes only the selected prospect's sole link. Never update/delete organizations.
```

Use bound parameters for every SQL value. Do not move the outer transaction or return a receipt before the command finishes.

- [ ] **Step 4: Exercise edge and rollback cases.** Add literal assertions for: assigning an existing unique target without creating a duplicate, legacy canonical match without alias, normalization-equivalent retry, null clearing leaves Bob and shared identity intact, two current links fail with unchanged rows, two matching target identities fail unchanged, whitespace rejected unchanged, bulk assigning two selected people leaves an unselected person intact, and an invalid later bulk person rolls back earlier link/new-identity changes. Assert original source receipts/aliases/properties are unchanged, not just the visible row label.

- [ ] **Step 5: Run GREEN and owned checks.** Run the two focused files, `tests/integration/importService.test.ts`, `tests/integration/leadDetailService.test.ts`, typecheck and owned-file ESLint under Node 24. Report whether native binding hash/mtime remained unchanged. Do not run package/browser/full suites.

- [ ] **Step 6: Freeze and review.** Write the task report with changed paths, RED/GREEN command evidence, preserved invariants, exact source hashes and unresolved concerns. The coordinator provides independent spec/quality review, then authorizes an exact-path commit such as `fix(leads): reassign one person without renaming shared organizations`.

### Task 2: Honest Inbox actions and empty-state claims

**Files:**
- Modify: `src/renderer/features/review/ReviewDetailPanel.tsx`, `ReviewPage.tsx`, `reviewKindMeta.ts`, `ReviewQueue.tsx`.
- Test: `src/renderer/features/review/ReviewPage.test.tsx`, `ReviewRoute.test.tsx`.

**Interfaces:**
- Consume unchanged `ReviewItem`, `ResolveReviewRequest` and `ReviewSnapshot`.
- Preserve the supported unmatched-communication Promote action and read-only Open person navigation.
- Do not add a generic capability cache or change main-process resolver semantics.

**Decisions:**
- The production resolver currently supports only unmatched-communication Promote. All other advertised write actions, including Mark personal, Repair invariant, fixture-only kind actions and ReviewPage's batch transcript acceptance, must not invoke unsupported commands.
- Render read-only evidence plus clear local guidance for unsupported actions. A privacy command that is unavailable must not imply Never Record was applied. Remove the arbitrary repair-command input.
- Empty state says no items are shown in this local review snapshot. It explicitly does not certify import completeness, identity completeness or adapter health. Use neutral styling rather than success.
- Do not remove stored review items, tabs or public union members. Complete counts, kind availability and pagination are a later separate stage and must remain open in the ledger.

- [ ] **Step 1: Add failing component behavior tests.** Render actual `ReviewPage`/`ReviewDetailPanel` with the existing strict fixtures. Keep the supported Promote path assertion. For unsupported actions require no enabled mutation control and verify user interaction cannot call `onResolve`. Require evidence text and Open person links to remain reachable. A representative assertion is:

```typescript
const unsupported = screen.queryByRole('button', { name: 'Mark personal (Never Record)' });
expect(unsupported === null || (unsupported as HTMLButtonElement).disabled).toBe(true);
expect(screen.queryByRole('textbox', { name: 'Repair command' })).toBeNull();
```

Test all six empty tabs with strict empty snapshots: no global success claim and a neutral, explicitly snapshot-scoped explanation. Also mount a nonconflicting multi-suggestion snapshot and assert its batch acceptance cannot issue unsupported commands. Do not test source text by grepping it.

- [ ] **Step 2: Observe RED.**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
npx vitest run src/renderer/features/review/ReviewPage.test.tsx src/renderer/features/review/ReviewRoute.test.tsx --maxWorkers=1 --minWorkers=1
```

Expected: enabled unsupported buttons/repair input and unqualified healthy wording fail new assertions.

- [ ] **Step 3: Implement the honest view.** Replace unsupported write branches with evidence and explicit unavailable guidance. Keep supported Promote construction unchanged. Change empty status to:

```tsx
<StatusBadge tone="neutral" label="No items in this view" />
<p>No items are shown in this local review snapshot. This is not an import-completeness or adapter-health check.</p>
```

Kind-specific wording may name the kind, but cannot assert every external event was captured. Remove now-unused state/hooks/props in affected branches, not unrelated components.

- [ ] **Step 4: Run GREEN, typecheck and owned ESLint.** Preserve existing real row selection, tab navigation and supported promotion regressions. Review changed expectations to ensure they now reflect production capabilities rather than hiding failures.

- [ ] **Step 5: Freeze for independent review and an exact-path commit.** Report F04 closed at the UI boundary, only the false-success-copy portion of F05 closed, and F05 complete-count/paging/availability still open. Parent owns actual signed-app acceptance after integration.
