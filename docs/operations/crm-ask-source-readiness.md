# CRM and Ask source readiness

This is the source-readiness inventory for [#496](https://github.com/david-cui-bruno/founding-sales/issues/496), implementing the approved [#479](https://github.com/david-cui-bruno/founding-sales/issues/479). It was prepared from merged `e15fda89` (schema83), including #494/PR514. It records inspected source contracts and existing controlled regression evidence; preparation ran no tests, upgrades, paid providers or live acceptance checks. The integration owner must bind final receipts to the final #496 source before closing the issue.

Source completion, disposable verification, provider evaluation, production release, signed desktop acceptance and activation are separate outcomes. [#466](https://github.com/david-cui-bruno/founding-sales/issues/466) remains held. [#497](https://github.com/david-cui-bruno/founding-sales/issues/497) owns later activation acceptance. This document authorizes no production writes, migration, release retry, infrastructure change, grant, budget, new recipients or send. Automatic admission and routine replies remain off; preserve cap5/lower caps, recipient-local weekday mornings, pacing, sender health, suppression/holds, uncertain-submit fences and the original Shirley receipt/cancelled follow-up.

## Evidence status and final-source receipt

**Controlled** below means existing tests assert the stated behavior through authenticated operations, registered workers and disposable PostgreSQL, or explicitly identified structural database checks. Historical passing receipts are recorded in [current-state.md](current-state.md). It does not mean a new run occurred during inventory preparation or that every column has independently measured lifecycle coverage. **Inspected** means the implementation/constraint is present but no distinct end-to-end erasure measurement is claimed here. **Unmeasured** names an outstanding acceptance gap. Table presence or a retention registry entry is not deletion proof.

| Final receipt | Status at inventory preparation |
| --- | --- |
| Exact final source SHA, schema and clean tree | Pending integration-owner freeze; inventory baseline `e15fda89`/83 |
| Full source gate, failures and skips | Pending exact-source receipt; retain failed attempts rather than replacing their history |
| Actual deployed schema63 →83 upgrade | Pending final-source run using the schema63 checkout's own migrations and fixtures; must execute64–69 and all later migrations |
| Actual source69 →83 upgrade | Pending independent final-source run using the genuine schema69 checkout and fixtures |
| Static checks, secret scan, independent Spec/Standards review | Pending final-source receipts |
| Desktop interaction/transport acceptance | Existing controlled tests; final run receipt pending; signed/native/live acceptance unmeasured |
| Production/schema/authentication observations | Historical schema63 evidence in current-state; no fresh observation made here |

Use the existing [upgrade runner](../../tools/upgrade/options.ts) with explicit `--from`, `--to`, `--base`, `--tree` and external evidence path. HEAD fixtures applied to HEAD are not a deployed-base upgrade. Preserve exact-schema refusal, stop–migrate–start, grants, immutable migration checksums, legacy operational identifiers/receipts, versioned desktop compatibility and forward-only recovery. A skipped CI upgrade step is not an executed upgrade. No concurrent-index protocol is introduced.

## Lifecycle and authority contract

The [coverage registry](../../packages/domain/retention/coverage.ts) classifies stores; [deletion.ts](../../packages/domain/retention/deletion.ts) collects original/current context closure, measures preview membership and fingerprints, locks and rechecks it, then removes/redacts private fields. A changed source, relationship, human decision, history title or action must invalidate an old approval even if counts are unchanged.

Source copies are indivisible. Deleting one original required context cannot preserve its words merely because another reviewed context survives. Temporary denial/disconnect is distinct from explicit copy deletion and provider-original disappearance. Reassociation does not erase original authority. Restore permits explicit recapture; it cannot resurrect old answers, action text, decisions or uncertain paid submissions. Human annotations are independent private leaf actions, not canonical communication/extraction inputs; see [ADR0008](../adr/0008-private-ask-history-and-human-actions.md).

The tables below identify private fields, actual lifecycle paths and inspected proof. Shared proof identifiers expand into precise files in the evidence index. Retained hashes/opaque IDs are not claimed to erase provider originals, backups or all metadata.

## Store inventory

### Identity and selected originals

| Store | Private fields / authority | Lifecycle and retained remainder | Status / proof |
| --- | --- | --- | --- |
| `crm_people` | `full_name`; owner or currently supported context, admin audit for exceptional evidence | Scoped deletion redacts affected names; unrelated supported person history survives. Copy deletion does not indiscriminately delete people | Controlled I |
| `crm_legacy_contact_people` | Contact/person IDs, no quoted body | Retained bridge prevents duplicate backfill and preserves operational IDs; does not independently authorize private reads | Inspected I / migration70 |
| `crm_relationships` | Source/context/date IDs; no excerpt | Source deletion invalidates support and requires review; current and captured authority remain necessary | Controlled I |
| `crm_relationship_revisions` | Structured association history, no copied excerpt or literal endpoint | Retained immutable decisions; cannot rebind old copied source context | Inspected I / migration71 |
| `crm_source_relationship_contexts` | Exact source/relationship revision, captured firm/person IDs | Retained context proof becomes review-required; direct and scoped deletion fence reads | Controlled I/E |
| `crm_identity_endpoints` | Literal address/phone `value`, plus dedupe hash | Literal redacted when no surviving current claim supports it; shared supported identities survive | Controlled I |
| `crm_endpoint_claims` | Typed endpoint/entity/source assertions | Deleted source invalidates support; unavailable claims cannot match or authorize sending | Controlled I |
| `crm_endpoint_claim_revisions` | Structured human decisions, no copied literal endpoint/body | Retained context/reference history; no duplicate body to recover | Inspected I / migration71 |
| `crm_selected_sources` | `excerpt`, `content_hash`, `occurred_at`; owner plus immutable original closure and current context | Public source/import delete and scoped deletion clear whole copy, advance revision and invalidate downstream work. Minimal identity remains; restore awaits explicit recapture | Controlled I/S/A |
| `crm_selected_imports` | `label`, `participants`, `attachments`, direction/attribution/date provenance | Selected-source hook clears copied metadata; scoped preview/commit includes its actual redaction; explicit recapture creates fresh metadata | Controlled S |
| `crm_selected_file_receipts` | File name/hash, source hash, length, format/parser/origin | Source delete clears selection provenance; correction marks stale; restore cannot authorize analysis without fresh selection | Controlled F; migration78 hook inspected |

### Business mail acquisition and recovery

| Store | Private fields / authority | Lifecycle and retained remainder | Status / proof |
| --- | --- | --- | --- |
| `crm_business_policies` | Mailbox/account binding, owner, disclosure/config versions | Independent disabled acquisition configuration; no body or sending permission. Live disclosure/account validation remains separate | Inspected B; live unmeasured |
| `crm_business_conversations` | Subject, participants, provider date and metadata identity | Versioned metadata deletion empties subject/participants/date; retained decision identity cannot restore content | Controlled B/M |
| `crm_business_decision_revisions` | Human include/exclude decision and actor/revisions, no source body | Durable overrides survive classification; new body capture still needs exact acquisition permission | Inspected B |
| `mail_messages` | Canonical body and message/attachment metadata; mailbox + original/current copy authority | Whole-copy deletion removes the retained body, without deleting Gmail original; held capture cannot publish after deletion | Controlled M |
| `crm_mail_sources` | Participants, passage ranges, sender/provider dates, account/provenance receipts; body resides in `mail_messages` | Public copy erase/scoped deletion clear or remove sensitive source proof, create tombstone and invalidate derivative work; original-availability observations remain distinct from copy availability | Controlled M/R |
| `crm_mail_source_contexts` | Original and reviewed person/firm/opportunity/match references | Deleted with affected mail copy; captured original and latest reviewed scopes participate in deletion despite reassociation | Controlled M |
| `crm_mail_capture_controls` | Exact owner/account/generation, grant/disclosure/policy/evaluation/release receipts | Disabled unless independently verified; disconnect/account drift vetoes acquisition. Configuration is not copied conversation content | Controlled B (fake proof); live unmeasured |
| `crm_mail_capture_identities` | Provider message ID/account binding, body-free operational context snapshot | Blocked/deletion identity prevents fresh grant from reviving erased copy; snapshot is constrained against arbitrary copied bodies | Controlled M; structural migration75 |
| `crm_mail_acquisition_tombstones` | Exact source/revision/hash and opaque capture identity | Retained deletion/awaiting-recapture identity prevents automatic reimport; explicit recapture is separate | Controlled M |
| `crm_mail_source_intents` | Source/revision/hash, no conversation text | Invalidated before successor publication when copy erased; no stale worker resurrection | Controlled M |
| `crm_mail_imports` | Provider account/binding, frozen time scope, history/page checkpoints | Body-free bounded import state; completion is enumeration proof, not complete body acquisition. Account/generation drift stops work | Controlled R; live volume unmeasured |
| `crm_mail_import_slices` | Time boundaries/page token and slice state, no body | Whole processed prefix/exhausted pages establish coverage; resumable overlap is deduplicated | Controlled R |
| `crm_mail_import_allocations` | Account/project/user hashes, unit costs/headroom, verification expiry | Operator configuration only; declared headroom is not a measurement of total Gmail traffic | Controlled R (fixture); live unmeasured |
| `crm_mail_import_read_reservations` | Method/units/opaque import/config identity | Unknown and observed reads both conserve quota across workers; immutable accounting survives source deletion | Controlled R; structural conservation guard |
| `crm_mail_import_messages` | Provider message/thread IDs/date and causal scope/reason | Terminal metadata redaction clears provider IDs/date, advances revision; quota accounting remains independent | Controlled R/M |
| `crm_mail_history_recoveries` | Gap ranges/history/page checkpoints, account/config/epoch | Bounded recovery and retention expiry clear causal checkpoints; opaque epochs/quota retained. Scoped source deletion must not erase unrelated mailbox coverage | Controlled R; live reconciliation unmeasured |

### Evidence, progress and promises

| Store | Private fields / authority | Lifecycle and retained remainder | Status / proof |
| --- | --- | --- | --- |
| `crm_extraction_generations` | Source/context/version and processing coverage receipt; no quote body | Delete invalidates generation/publication; restore does not revive it | Controlled X |
| `crm_extraction_claims` | Quotes, interpretations and claim/context projections | Direct source hooks/scoped deletion remove affected claims across versions; human decisions remain independent | Controlled X/E |
| `crm_extraction_purposes` | Route/model/grant/data-handling/evaluation/budget configuration | Disabled/default unavailable; independent approved purpose required; no source body | Controlled X; real route/grants unmeasured |
| `crm_extraction_financial_receipts` | Opaque priced attempt/reservation/config proof | Accepted and unknown spend survive private erasure; uncertain original attempt cannot be resubmitted after recapture | Controlled X; vendor bills unmeasured |
| `crm_claim_review_anchors` | Exact semantic/context/owner identity and original event/observation dates | Copy delete marks unavailable, clears original dates and vetoes old approval; minimal identity remains | Controlled E |
| `crm_claim_decision_revisions` | `corrected_interpretation`, `rationale` across all revisions | Whole-copy deletion clears correction/rationale history; dated action identity remains | Controlled E |
| `crm_claim_conflicts` | Body-free conflict identity/revision | Every member's captured/current authority required; no arbitrary winner or copied quote store | Controlled E |
| `crm_claim_conflict_revisions` | Human conflict `rationale` and dated decisions | Deleting any member clears rationale across revisions; cannot recover it through history | Controlled E; scoped SQL inspected |
| `crm_claim_conflict_members` | Exact member anchor/version references | Retained body-free membership; access requires all members, not selected winner alone | Controlled E |
| `crm_claim_work_dependencies` | Exact work/anchor/version references | Evidence drift flags open work for review; completed real-world facts remain | Controlled E/P |
| `crm_mail_progress_receipts` | Verified dated source/match/claim proof, no new mail body | Deleted attribution receipts removed with source; imported draft/forward cannot become actual contact/reply evidence | Controlled P/M |
| `crm_mail_reply_resolutions` | Sent-receipt reference/request provider date | Attribution redacted; permanent completion identity prevents rearming answered work | Controlled P; migration77 redaction guard |
| `crm_mail_progress_scan_cursors` | Last source ID only | Retained coverage position; not proof of projection completion/permission | Inspected P |
| `crm_commitment_reviews` | Human action label/due/actor/target, original/current proof, projection receipt | Source/scoped deletion clears private activation proof; correction requires review and cannot silently reactivate | Controlled P |
| `crm_internal_tasks` | Review/activation receipt, version and completion facts | Private proof erased; open tasks require review; completed identity/time remain immutable. No enrollment/sending effects | Controlled P |

### Ask and human leaf actions

| Store | Private fields / authority | Lifecycle and retained remainder | Status / proof |
| --- | --- | --- | --- |
| `crm_ask_requests` | Question, input scope/contexts/original closure, answer result and history title | Every initial input, including uncited inputs, gates read/publication. History delete and source delete erase question/result/title/windows; epoch/version fences old workers | Controlled A/H |
| `crm_ask_request_windows` | Body-free canonical locator/hash/context/group proof; no copied passage body column | Windows removed with whole affected request; navigation checks exact request version and current canonical source | Controlled A/H; structural window guards |
| `crm_ask_purposes` | Purpose-specific route/model/grant/data policy/evaluation/cost caps | Independently disabled; unevaluated support/retrieval routes fail before transfer | Controlled A; real provider/evaluation unmeasured |
| `crm_ask_financial_receipts` | Opaque stage/attempt/reservation proof | Conserved accepted/unknown charges survive erased private authority; recovery does not blindly repeat ambiguous submission | Controlled A/H; vendor acceptance unmeasured |
| `crm_ask_actions` | `human_text`, due, target, full input scope/contexts/original closure/support refs | Independent task/note/preference survives history-only deletion. Original source mutation clears all private fields, flags open work, preserves done status/time. Reads/completion revalidate every original input; restores never revive old text | Controlled H; structural parent/version guards |

### Existing originals and operational sinks

| Store/sink | Inventory boundary | Proof and outstanding limit |
| --- | --- | --- |
| `call_transcripts` | `utterances`, exact native revision and channel/diarizer attribution | Controlled N/X/A canonical read/lifecycle; scoped deletion removes transcript. Physical fixture deletion is not a live recording purge |
| `meeting_transcripts` | `utterances`, version and original meeting/recording context | Controlled N/X/A; meeting cascade and CRM invalidation fence saved answers; live recording workflow unmeasured |
| `call_summaries` | `summary`, `next_steps`, `commitments` | Explicit scoped removal and session cascade inspected; existing retention regression. No new per-column run claimed |
| `call_analyses` | `result`, `notes`, `proposals`, transcript/proposal hashes | Explicit scoped removal and session cascade inspected; controlled native analysis tests; live provider acceptance unmeasured |
| `meeting_note_revisions` | `debrief`, `speaker_mappings`, `item_overrides` | Meeting deletion cascades all revisions; inspected scoped path, existing meeting retention tests |
| `meeting_analyses` | `overview`, `items`, `review_reasons`, source hash | Meeting cascade removes private analysis; existing meeting retention tests; live model quality unmeasured |
| `meeting_analysis_requests` | `result`, linked meeting ID; opaque attempt/reservation totals | Private result scrubbed by meeting deletion; independent attempt accounting retained. Existing meeting retention/accounting tests |
| `call_tasks` | `text`, due/context/quote references | Explicit scoped deletion removes affected operational tasks; Ask manual actions do not write these rows |
| `meeting_tasks` | `label`, `deadline`, `due_at`, `evidence`, context IDs | Meeting cascade/retention removes affected private tasks; new CRM task facts use their separate body-free receipt |
| `meeting_follow_through` | Contact/analysis/plan references and review/version state | Existing scoped meeting deletion cascades plan; enrollment/sending fences remain separate, tested in follow-up retention |
| `meeting_follow_through_drafts` | `subject`, `body`, material/source references | Plan cascade removes drafts; delivered outbound facts retain their own policy. Ask never creates/approves these drafts |
| `firm_prepared_briefs` | `brief`, `sources`, observation date | Explicit firm-scoped removal inspected; no new native per-column deletion measurement claimed |
| `jobs`; command receipts; audit events | Source/connection generation/fence identifiers and bounded metadata; no questions/results/quotes in new Ask receipts/errors | Controlled A/H and structural payload contracts; persisted generic jobs retain existing sweep policy. Audit-failure refusal is tested; this is not a claim all historical metadata instantly disappears |
| Provider originals, audio/object storage, backups/PITR | Separate retention/provider/native boundaries | Unmeasured live purge/recovery; do not promise instant backup or vendor-original deletion |

## Evidence index and what the assertions establish

These are relative source links, not newly executed reports. The integration owner should pair them with the exact final gate/upgrade artifacts and retain earlier failure evidence.

- **I — identity:** [peopleDeletion](../../packages/domain/test/retention/peopleDeletion.test.ts) exercises indivisible mixed-firm erasure, unrelated person-history survival, concurrent read/deletion and same-count revision staleness. [identityAccess](../../packages/domain/crm/identityAccess.ts) locks captured/current people and firms before source bodies.
- **S — selected metadata:** [selectedImports public tests](../../apps/api/test/selectedImports.test.ts) assert deleted excerpt and participant/attachment fields are null, replay denied, restore awaiting recapture. [scoped imported-metadata test](../../packages/domain/test/retention/selectedImports.test.ts) compares preview and committed redaction.
- **F — selected files:** [selectedAttachments](../../apps/api/test/selectedAttachments.test.ts) covers explicit selection/analysis, stale provenance, deletion and controlled processing; migration78 clears file receipt fields rather than merely dropping a UI link.
- **B/M — business capture/deletion:** [businessMailCapture](../../apps/api/test/businessMailCapture.test.ts), [businessMailDeletion](../../apps/api/test/businessMailDeletion.test.ts) cover exact controls, held provider waits, original/reviewed context erasure, unchanged-count approval staleness and saved-question erasure. [nativeMailEvidence](../../packages/domain/crm/nativeMailEvidence.ts) resolves retained originals without a provider fetch on read.
- **R — backfill/recovery:** [crmMailBackfill](../../apps/api/test/crmMailBackfill.test.ts) and related backfill suites exercise frozen boundaries, denied allocations, retry exhaustion and recovery. Migration80 constrains read reservation conservation and separates provider-original observations from retained copies. These are controlled adapters, not real Gmail throughput measurements.
- **X/N — processing/native:** [crmProcessing](../../apps/api/test/crmProcessing.test.ts), [crmMailProcessing](../../apps/api/test/crmMailProcessing.test.ts), [crmEvidenceNative](../../apps/api/test/crmEvidenceNative.test.ts) exercise canonical source/version/owner checks, unknown acceptance after delete/recapture and native financial health without private text exposure.
- **E — decisions/conflicts:** [crmEvidenceContextDeletion](../../apps/api/test/crmEvidenceContextDeletion.test.ts), [crmEvidenceDecisions](../../apps/api/test/crmEvidenceDecisions.test.ts), [crmEvidenceMailConflicts](../../apps/api/test/crmEvidenceMailConflicts.test.ts) cover original A authority after B recontextualization, protected human history and all-member conflicts. Scope collector/SQL redacts every affected rationale revision.
- **P — progress/promises:** [crmProgress](../../apps/api/test/crmProgress.test.ts), [crmCommitmentContextDeletion](../../apps/api/test/crmCommitmentContextDeletion.test.ts), [crmCommitmentPermissionLoss](../../apps/api/test/crmCommitmentPermissionLoss.test.ts) verify supported activity, original proof after re-review and current permission refusal. Migration81 distinguishes promises from arbitrary Ask tasks.
- **A — Ask:** [askAnswerPrivacy](../../apps/api/test/askAnswerPrivacy.test.ts) asserts unanswered-question preview coverage, accepted charge after held deletion, direct-copy restore refusal and cross-owner/current-version citation refusal. [askAnswerRecoveryDeletionRace](../../apps/api/test/askAnswerRecoveryDeletionRace.test.ts) covers unknown charge recovery vs deletion. [askAnswerSafety](../../apps/api/test/askAnswerSafety.test.ts) refuses fabricated/malformed citations and unsupported inference/unevaluated adapters.
- **L — integrated lifecycle:** [native/mail manual-copy lifecycle](../../packages/domain/test/db/askManualSourceLifecycles.test.ts) measures all three native/mail kinds with uncited inputs, physical deletion, revision changes and restored-copy refusal; completed status/time and unrelated cited copy survive. [authenticated cross-feature tracer](../../apps/api/test/askManualCrossFeatureLifecycle.test.ts) joins two explicit opportunities, native meeting and selected-copy inputs, keyword-confirmed human task completion and scoped deletion with exact preview/commit counts plus unrelated-scope survival. These are new disposable checks, not provider acceptance. [upgraded Ask workflow](../../tools/upgrade/askWorkflows.ts) exercises the actual upgraded database as runtime role, with no HTTP/registered-handler claim. Source69 historical supplements in [source69Seeds](../../tools/upgrade/source69Seeds.ts) use schema69 column shapes; toy approval metadata/zero-cost historical receipts are explicitly synthetic and inert.
- **H — history/actions:** [askHistoryPrivacy](../../apps/api/test/askHistoryPrivacy.test.ts) holds a registered answer worker, renames history, rejects stale deletion CAS, deletes, resumes accepted processing and asserts source retained/charge conserved/no retry. [askActions](../../apps/api/test/askActions.test.ts) asserts history survival, completed facts after source erasure and no restoration; [askActionAccess](../../apps/api/test/askActionAccess.test.ts) withholds bodies after authority loss; [askActionDeletion](../../apps/api/test/askActionDeletion.test.ts) compares scoped preview/committed action redaction. [desktop history](../../apps/desktop/test/askHistory.component.test.tsx) includes readable untitled rename/pin; [manual work](../../apps/desktop/test/manualWork.component.test.tsx) covers privacy/fresh version interactions.

## Evaluation and activation gaps

The frozen evaluation suite has **120 synthetic bindings:80 development and40 sealed holdout**. #492's retained reports used fake vectors and scripted abstaining answers. They establish bounded orchestration, manifest binding and deterministic authority/control refusal; they do not establish semantic recall, supported real-model answers, useful inference or production cost/latency. Null/absent quality metrics remain unmeasured. Earlier measured lexical fixture results showed broader keywords improving recall while adding noise. Those scoped keyword measurements remain separate from fake-vector control rows and untested real vector/model proposals; do not generalize them to live quality or invent unavailable scores.

Before any semantic/provider selection, separately freeze representative authorized scope, parser/chunker/model versions, independent labels/holdout, thresholds and call/token/spend/latency limits; measure lexical/vector/fused retrieval and answer support/abstention on identical eligible inputs. Approved catalog entries or JSON validity are not passing evaluations.

Outstanding live acceptance includes exact OAuth/account permissions and disclosure/Google data-policy compatibility; actual Gmail acquisition/headroom/backfill; purpose-specific hosted route/grant/data-handling/retention/funding; real provider acceptance and vendor billing; useful vector/model/support quality and thresholds; production extension availability; authenticated managed release before drain/after idle; schema migration/PITR recovery; signed desktop/native recording/Phone/Messages workflows. Keep these unavailable or explicitly unverified. No installed desktop credentials, personal-message scraping or additional provider originals are authorized.

Closing #496 may certify only the final reviewed source and controlled evidence. #497 and the normal release process must independently resolve applicable live gates while preserving #466 and all sending safeguards.
