# Supported LinkedIn profile Routes: #626 source acceptance

Date: 2026-10-13. Source-only evidence, not a deployment or live-account claim.

## Caller outcome

The normal authenticated product API supports this selected-evidence journey:

1. Create/read a Person and capture a permitted selected note with existing `/crm/people/create`, `/crm/people/source/add` and `/crm/people/read` commands/reads. Firm-owned selected evidence is also usable when its current explicit source context actually binds the Person and firm.
2. Save the source-backed current firm relationship with `/crm/relationships/save`.
3. Claim, list or correct a profile using existing `/crm/endpoints/claim`, `/crm/endpoints/list` and `/crm/endpoints/correct`, with `kind: "linkedin"`. Exact stored source ID, revision and hash are required. Claims are recorded assertions, not proof of fit or send permission.
4. POST `/crm/linkedin/routes/assess` with only `{ "claimId": "<uuid>" }`. A supported result is `state: "eligible"`, with the stable endpoint Route ID, current claim and relationship revisions, Person, firm, role, observed profile and both evidence references. Otherwise the read returns a held reason and no Route. Inaccessible or cross-workspace identity returns 404. Client proof/fit flags are rejected.
5. To record an explicit human stop, POST `/crm/linkedin/routes/refuse` with the normal command envelope, exact claim ID/expected revision, recorded firm ID, relationship ID/expected relationship revision, and `scope: "person" | "firm" | "ambiguous"`. Scope is an owner decision over the currently accessible stored identity snapshot, not candidate-supplied technical proof. The accepted command is idempotent, audited and content-free. There is no automatic release, cooldown or per-recipient approval queue.

Every assessment returns `sendingPermission: false`, `connectionState: "unknown"`, `maintenanceNeed: "unknown"` and `buyingIntent: "unknown"`, including positive fit. It does not mean an invitation was accepted or any action is permitted. Canonical #634 remains settled and unchanged. No LinkedIn credentials, network fetch, browser, invitation or DM operation was added.

Desktop endpoint rendering/correction preserves the new profile kind and exact evidence/revision. It does not run the existing email/phone identity matcher for profiles. The accepted end-to-end #626 seam is the authenticated product API, not a new desktop campaign flow.

## Deliberately narrow evidence interpretation

The resolver reads actual stored selected-source text, owner/access context and versions. It does not trust an arbitrary client-declared Person, fit flag, parsed proof or display-name match. Supported selected prose makes explicit named assertions, for example:

```text
Taylor Park is the owner of Harbor Management.
Taylor Park's LinkedIn profile is https://www.linkedin.com/in/taylor-example.
Harbor Management is an independent residential property management firm serving Providence, Rhode Island.
```

Other supported roles are founder, president, principal, partner, director, property manager and operations manager. Firm predicates support an independent or regional residential property management firm/company/business, serving or based in the recorded locality and state. Existing approved target geography is reused: Texas and the existing Providence/Boston-area locality lists. This does not inherit the email qualification requirement for website verification, business phone or email readiness.

Unfamiliar prose remains held. Negation/uncertainty, another person's profile/role, same-name borrowing from another Person's source, a vendor helping property managers, or a competitor mentioning another PM firm are not positive support. Profile normalization accepts only an observed HTTPS `linkedin.com`/`www.linkedin.com` `/in/` profile without credentials, port, query or fragment. URL normalization/deduplication is not identity support. Duplicate profiles, shared profiles, multiple plausible current relationships and duplicate current firm identity remain reviewable, without an automatic merge.

## Acceptance mapping

| #626 requirement | Source implementation and observed acceptance evidence |
| --- | --- |
| Candidate or permitted selected evidence yields Person/firm/profile Route or hold | Selected-evidence alternative exercised through authenticated commands and the real PostgreSQL read. Positive caller sees stable Route, Person, firm, role and source versions. No email/phone/website is needed for the positive case. |
| Correct residential PM fit and approved geography, without unsupported need/intent | Existing target policy reused with subject-qualified firm evidence. Wrong area, no fit, other-company attribution, website vendor and competitor cases are held. Need/intent/send permission remain explicit unknown/false. |
| Ambiguous names, guessed URLs, shared endpoints and duplicates cannot become identity | Public tests falsify cooccurrence, an identically named different Person, invalid and unobserved URLs, shared profiles, duplicate profile claims and multiple relationships. Exact source owner/context binding is checked before interpreting named assertions. |
| Evidence/history and original context remain visible and stable | Positive correction caller readback exposes claim revision 2 and new observed profile/evidence while retaining original relationship evidence/context revision and past endpoint assertion history. Stale revisions fail. Relationship correction retains the existing required-review behavior. |
| Current workspace/owner/assignment access after waits | Cross-workspace and non-owner reads/commands fail. Exceptional admin private evidence reads are audited. Indivisible additional original firm context cannot be bypassed. Real PostgreSQL barriers verify reassignment and membership revocation before publication. |
| Refused Person/firm and uncertain scope stay held; no referral bypass | Explicit content-free `person`, `firm`, `ambiguous` stops retain exact claim/relationship snapshots and audit. Firm/ambiguous stops hold another supported Person at that firm. Person stops do not invent a firm-wide refusal. Existing firm and current supported Person-handle suppressions also hold a Route. |
| Deletion/revocation/correction cannot resurrect or publish stale evidence | Actual selected-source deletion clears profile literal/list publication, invalidates eligibility and refuses ordinary same-key reimport. Stop rows contain no profile/name/excerpt and survive deletion, profile correction and assignment changes. Real PG correction/deletion waits re-read original context/access and refuse stale publication/stop writes. |
| Genuine red/green, supported caller seam, source-only report | Sequential tracer observations below precede implementation. API tests use normal authentication/command receipts plus actual PostgreSQL; concurrency uses held transactions and observed `pg_blocking_pids`, not a fake repository. Exact-head CI and independent Spec/Standards review remain coordinator gates. |

The explicit stop table checks workspace-scoped foreign keys to the original Person, firm, endpoint, assertion revisions and actor membership. Application roles have SELECT/INSERT only. UPDATE/DELETE/TRUNCATE are revoked. Stop and audit rows retain identifiers/codes only, not conversation content. Account/provider changes cannot clear them because no account credential or provider lifecycle owns this data. Recursive firm lineage keeps merged-firm stop/suppression identities effective, without modifying the original decision snapshot.

## Real RED/GREEN observations

- First tracer: normal selected-evidence profile claim returned HTTP 400 instead of 200 because the existing endpoint contract lacked the profile kind. Real PostgreSQL test was 1/1 RED before the minimum implementation. First GREEN was 1/1, 402 ms, then committed as `440c2b3f`.
- Second vertical falsification: another person's profile merely cooccurring with the requested name was incorrectly eligible, and the explicit stop command was absent (404). Minimum explicit attribution and stop implementation produced GREEN.
- Third vertical falsification: a same-name different Person borrowing a source and duplicate firm identity were incorrectly eligible. Source identity binding and duplicate firm hold produced GREEN.
- Final fit falsification: three independent authenticated PostgreSQL cases returned eligible instead of `firm_fit_unsupported`: websites for another PM, website design for PM customers, and competing with a PM firm. At 14:37:38 local time the focused run had three failures (exit 1). A minimum subject-qualified named firm predicate made all three GREEN, while the ordinary supported positive case remained eligible.
- Constraint inventory falsification: the unchanged `test/db/constraints.test.ts` guard found 11 new refusal constraints without negative cases (2601 passed, 1 failed, exit 1). Added real failing inserts for all 11 and six actual app_runtime/migration UPDATE/DELETE/TRUNCATE permission refusals. The unchanged inventory then passed 2619/2619, exit 0.
- Setup failures are not counted as behavioral RED: Node 24.13.0 failed locked dependency engines, an attempted direct source-owner update correctly hit the existing immutable-owner trigger, and test expectations were corrected for the existing command replay envelope and relationship correction review behavior. None justified relaxing invariants.

## Local verification

The coordinator-provided checksummed official Node 24.20.0 runtime was used with normal engine enforcement and isolated locked dependencies installed by `npm ci --no-audit --no-fund`. No new dependency/product, lockfile change or shared node_modules symlink was introduced. Existing embedded PostgreSQL install/hydration scripts were run locally.

```bash
export PATH=/Users/davidcui824/.jcode/scratch/node-runtime-24.20.0/node-v24.20.0-darwin-arm64/bin:$PATH
npm run test --workspace apps/api -- test/linkedinRoutes.test.ts test/peopleRelationships.test.ts
npm run test --workspace packages/domain -- test/sourcing/qualificationPolicy.test.ts test/retention/targets.test.ts test/retention/peopleDeletion.test.ts test/db/migrations.test.ts
npm run test --workspace packages/domain -- test/db/constraints.test.ts
npm run test --workspace apps/desktop -- test/endpoints.component.test.tsx
npm run typecheck
npm run lint
git diff --check
```

Observed results on the final implementation:

- API: 22 LinkedIn Route tests and 20 existing Person/relationship tests, 42/42 passed.
- Domain: qualification policy 39, retention targets 14, Person deletion 8, migrations 20, 81/81 passed. Migration tests include the previous-schema upgrade and exact binary/schema startup refusal contract.
- Domain constraint inventory: 2619/2619 passed, including every new refusal constraint and both application roles' append-only permissions. Guard SQL and missing-case assertion remain unchanged.
- Desktop: 6/6 endpoint component tests passed, including Person/firm profile corrections and unchanged email behavior.
- Root typecheck and lint (`eslint --max-warnings 0`): exit 0. Diff whitespace check: exit 0.
- Final combined API/domain/typecheck/lint verification task `920173zabw`: exit 0 on October 13, 2026 at 14:43:38 local time. Desktop/static task `768508jwi8`: exit 0. Final constraint-inventory/root typecheck/lint/diff verification task `244768xlbg`: exit 0 at 14:48:16 local time.

Implementation commits: `440c2b3f` and `7264044e`. Additive migration 0106 and required schema 106 belong to this isolated branch; coordinator reconciles numbering if another independent source ticket also adds 106.

## Remaining gates and boundaries

There is no known incomplete #626 source behavior in this acceptance seam. Full exact-head CI and independent Spec/Standards reviews are not claimed here and remain coordinator-owned before publication/merge. No push, PR, issue write, merge, deployment, production database access, paid/provider action or live LinkedIn acceptance was performed. This is not evidence for later sending/invitation/reply tickets, broader natural-language interpretation, production activation, or a changed canonical #634 policy.
