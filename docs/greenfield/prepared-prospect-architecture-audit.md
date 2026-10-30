# Prepared prospect yield audit and architecture

October 30, 2026 · #797 under #783 · retained evidence and source inspection only.

David approved broad, high-volume prospect preparation with unknowns visible. Email stays OFF; research/search budgets, paid fan-out, pacing, source/privacy controls, contact safeguards and paused schedules stay unchanged. This audit selects the next implementation; it changes no application behavior, records, attestation or production configuration.

## Result

Useful research is currently gated by a narrower canonical/publication contract. Separate a **prepared company brief** from email eligibility and canonical Firm creation. Reuse retained evidence, the existing candidate/priority read path, workers and database. Do not add another sourcing service, model vendor, scheduler or per-company approval step.

Five handpicked companies with expanded October27 originals support useful dated briefs. This is a finding about those originals, not current source rights, representative precision, new-producer success or five new live publications.

| Company | Useful source-backed context | Unknowns and distinctions to retain |
| --- | --- | --- |
| Alta Residential | Texas single-/multifamily management; Dallas office versus broader service markets; account-manager and maintenance/vendor workflow; published general routes | No named buyer, confirmed pain, current route ownership or buying intent |
| RPM Focus | Frisco residential management; a dated first-party owner lead, Brian Poduska; general business phone | No saved email; national network staffing/scale does not establish the local operation |
| Nexus RI franchise | Pawtucket office versus Providence service market; dated portfolio claim; hotline/staff/vendor workflow | Response-line purpose; other franchise territories are distinct; no saved email or current buyer |
| North Texas Property Management | Single-family management and named DFW markets; compact office contact card; dated CEO/President lead | Selected address alone fails the later scoped-service predicate; observed phone is distinct from strict callable proof |
| RentProv Realty | Providence residential leasing/sales/management brokerage; compact office contact card | Mixed business scope; city heading alone fails scoped-service predicate; listings agents/testimonials do not establish a buyer or internal pain |

The five stored strict verdicts stay `review`/`fit_only`. Existing fit judgments and approved questions are unchanged. Evidence details remain in the private retained audit; no copied endpoint or original collection belongs in this document.

## Denominators and limits

These snapshots overlap and must not be added together. All are retained observations preceding or shortly following PR859, not a new live cohort evaluation.

- **357-record predicate snapshot:** first stops were236run-state/result,32revision/version,68identity,8residential-fit,8service-area,3source and2email-only. The last two show email can be the final blocker; removing email alone cannot fix the larger funnel. Exact canonical identity/post-lock publication checks were outside this snapshot.
- **Newest30 metadata window, October29 11:59UTC:**16review/14unavailable; current native evidence yielded3pure positives,8identity failures,5service-area failures,14not evaluated. Metadata inspection is not30manual original reviews; source/retention authority was not established by that snapshot.
- **16 ordinary runs after PR857, before PR859:**8had no observations,2had only truncated observations,6failed literal identity matching. Those ten source/coverage failures cannot honestly be relabelled as ten prepared companies.
- **Six saved identity selections:** Zanno/Plano/Northeast have short brand labels; Scott Brown and Green Ocean have useful descriptive paragraphs; Thayer has an accreditation-bearing company label. The latter three are outside the shipped fallback's format rules. Only the selected passages were saved in this artifact; full rejected model selections/all original blocks are unavailable. Do not claim all six would publish after another parser change.
- **First PR859 post-release snapshot:**0prepared/0new qualification attempts. Its producer had not been live-exercised. Deployment is accepted; usefulness remains open.

The five-company original review and six identity excerpts are intentionally different evidence depths. No acquisition/model/test replay, cloud operation, production write, fit vote, contact or schedule change was needed for this audit.

## Structural causes

1. [Publication proof](../../packages/domain/sourcing/automaticResearchProof.ts) returns null unless native citations **and an eligible business-email route** pass. [Publication](../../packages/domain/sourcing/automaticResearch.ts) also requires a uniquely matching canonical Firm identity, including exact name/site/locality/region/owner. These are prerequisites for the current publication kind, not necessary properties of useful research.
2. [Discovery](../../packages/domain/sourcing/discovery.ts) stores a title-derived name and query locality. The [model instruction](../../packages/domain/sourcing/qualificationPrompt.ts) treats that candidate as the literal target; the [new interpreter](../../packages/domain/sourcing/preparedIdentity.ts) can accept a different source-derived name. Changing only interpretation leaves an upstream instruction mismatch. Whole-block/name-suffix grammar also confuses evidence presentation with canonical identity.
3. [Citation roles](../../packages/domain/sourcing/qualificationCitationRoles.ts), [native evidence](../../packages/domain/sourcing/nativeFirmEligibility.ts) and [scoped service area](../../packages/domain/sourcing/scopedServiceArea.ts) require specific wording/block arrangements. An office address, a separate company heading and a residential-services paragraph can support a brief without satisfying that composite strict verdict. Query locality must remain a search hint; observed office and service markets are separate claims.
4. [Qualification](../../packages/domain/sourcing/qualificationRun.ts) offers only wholly untruncated observations and retains no extracted facts after role rejection. Coverage and exact citation validity need separate treatment from semantic interpretation: one invalid association must not destroy independently valid research fields. Absence claims still need sufficient coverage.
5. [Prepared UI](../../apps/web/src/client/BrowserResearchQueue.tsx) lists only qualified/automatic publication actions. The [qualified retained path](../../packages/domain/sourcing/qualifiedResearchProof.ts) permits unresolved email but still requires native/canonical/promotion lineage; email gating is specific to automatic publication. Existing [permitted candidate reads](../../packages/domain/sourcing/manualProspectRows.ts) and [priority](../../packages/domain/sourcing/prospectPriority.ts) already retain plausible companies with unknowns. Useful research is therefore hidden behind a stricter entrance than the product goal requires.
6. [TodayV4](../../packages/domain/today/actionsV4.ts) enumerates every automatic publication and repeats full proof reads. This is a source-level scalability concern, not a measured production latency result. A high-volume prospect list needs bounded pagination and selected detail loading.

## Chosen design

**One candidate-based preparation module, separate strict channel owners.** Its interface lists a bounded ranked page and reads one exact candidate/revision's brief. Internally it reuses current candidate/source rights and retained evidence. Listing/opening never creates a Firm, route, campaign, enrollment, provider reservation or research job.

A brief presents observed business name/site, why it plausibly fits residential PM, observed office/service markets, useful workflow context, any dated people/endpoint observations, explicit unknowns and a next research action. Each supported field has original references/date and coverage. Search title/query geography are labelled discovery hints. Unsupported fields stay unknown; no generic pain claim or mandatory email/phone/buyer/units/software prerequisite. Existing support and mixed brokerage scope are context, not automatic rejection.

Keep distinct states:

- **Prepared:** substantive retained business evidence supports a useful company brief, even when contact details, precise geography, intent or buyer are unknown.
- **Needs research:** permitted search/source material exists but meaningful company identity/fit is unresolved or conflicting. Show the actual gap; do not count a search snippet alone as a prepared brief.
- **Unavailable:** current access, source/retention/deletion or dismissal rules prohibit the projection. Optional field expiry removes that field; source erasure/rights loss removes its dependent content. No stale-name fallback.

For preparation, accept an exact name span inside a descriptive original and associated same-page sections with explicit attribution; do not require one standalone brand block or a business-suffix dictionary. Preserve contrary names and franchise/office scope. Ambiguity prevents canonical association/contact use; a permitted research item can still expose the conflict without guessing. Geography can be an explicitly sourced office or service market with unresolved parts; literal full city+state adjacency is not a blanket display prerequisite.

Keep current byte/capture/token bounds and robots/network protections. Incomplete retained material can supply individually intact positive passages with coverage disclosed only when the new preparation interpretation validates exact references and attribution. It cannot prove an absence or override contradictory retained evidence. Do not change `truncated` to false or reinterpret old strict verdicts. First implementation can use complete observations; partial-coverage support is a separate changed-behavior slice, not a dependency for first value.

Use existing soft priority and ordinary-company coverage. Group duplicate presentation conservatively by supported company/branch/site context, retaining all originals; do not automatically merge franchise buyers or rewrite canonical CRM identity. Missing metadata lowers completeness, not existence. Technical lineage belongs in details, while the default brief shows the business, evidence, unknowns and next action.

## Implementation order and acceptance

1. **Read existing evidence into useful briefs first.** Add a candidate-based list/read projection beside the current strict publication consumers, reusing exact-subject permission/source-loss checks and existing priority. Page at most50metadata rows; fetch bounded originals only for selected detail. No migration, canonical publication, paid replay or new producer required for this first read-only slice. Existing valid selected facts/whole originals can be displayed as dated evidence without fabricating replacement facts in old runs. Recheck actor/revision/source/expiry after waits and clear stale browser detail.
2. **Make ordinary extraction match this contract.** Use an explicitly versioned future-run instruction/interpretation that treats search title as a hint, selects original identity spans/context and preserves independently valid fields plus contrary evidence. Do not mutate queued/old runs, reset attempt fingerprints, force a new paid same-day attempt or reuse the old attestation as measured new-producer quality. Keep the same approved provider/model/budget owners and ordinary pacing.
3. **Measure the funnel during ordinary processing.** Track unique discovered companies → usable source coverage → prepared briefs → channel-ready prospects, with explicit first-stop/unknown reasons, dates, per-search and per-company costs. Search result URLs, raw candidates, canonical Firms and prepared briefs have separate denominators. Report observed yields; do not invent a success percentage or numeric quality target from this handpicked cohort.

Acceptance must show Focus and Nexus still have useful briefs without an email, NTX/RentProv retain supported business context without one magic service-area block, and the six identity excerpts retain supported text without title/canonical-name fabrication. Missing observations remain needs-research. Include cross-workspace/actor loss, deleted/expired source, revision changes during waits, conflicting offices/franchises, duplicate grouping, bounded pagination/reload and unchanged saved fit judgments. Prove list/read produces zero provider calls and zero business writes; strict admission/calling/email consumers continue refusing unresolved inputs. Verify actual hosted useful briefs after normal CI/review/protected delivery; an offline audit is not deployment.

The search adapter retrieves at most20hits/search and creates at most5new candidates/search. At10searches/day the structural maximum is50new candidates/day before duplicates/failures, not50prepared companies. Keep those limits unchanged. Recovering useful yield and avoiding duplicate work precede any separately authorized capacity change.

This preparation contract revisits the email/canonical entrance in [ADR0014](../adr/0014-automatic-qualified-research-supply.md), not [ADR0016](../adr/0016-automatic-research-campaign-composition.md)'s strict campaign authority. The implementation must record that distinction explicitly. [ADR0031](../adr/0031-prepared-source-identity.md) remains the deployed narrow producer; this audit does not silently widen it. Owner OFF, consent/eligibility, suppression/DNC, route identity/type, source/privacy, caps/pacing/holds/UNKNOWN and protected delivery safeguards stay with their existing owners.
