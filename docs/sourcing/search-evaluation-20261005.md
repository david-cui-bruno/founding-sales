# Tavily Basic live evaluation — 5 October 2026

## Outcome

The existing adapter completed all nine versioned queries: nine provider-reported credits, 32 retained hits, 30 distinct URLs. No errors or usage-contract mismatch. Free Researcher plan showed 1,000 monthly credits and pay-as-you-go disabled before execution. The key was read from the user-copied clipboard into process environment, never saved in source or output; the matching clipboard value was cleared afterwards. No recurring work, candidate admission, CRM writes or messages were activated.

This establishes live connector compatibility, not autonomous qualification quality. Retain Tavily as a candidate-discovery connector; revise query families and qualification before scheduling it.

| Query family | DFW hits | Providence hits | Boston hits |
| --- | ---: | ---: | ---: |
| Explicit burden | 4 | 3 | 2 |
| Coordination | 4 | 2 | 2 |
| Fit only | 5 | 5 | 5 |

Counts are returned links, not qualified firms. Two exact-URL repeats; firm-level duplicates are additional. No CRM database comparison was performed. Raw native search artifacts and the durable ledger remain outside the repository in ~/.local/share/callie/sourcing-evaluation/.

## Source checks and corrections

These spot checks used web reads of the firm-owned pages, not the production bounded fetcher; they do not prove production extraction coverage.

- [RPM Providence careers](https://www.realpropertyprovidence.com/property-manager-careers): the page describes common roles that may be available and asks visitors to inquire about current openings. Its maintenance-coordinator text is NOT evidence of an active vacancy. Do not score this as a current hiring trigger.
- [LEAP maintenance coordination](https://www.leapdfw.com/full-service-property-management/maintenance-coordination/): explicitly describes a dedicated maintenance coordinator and 24-hour on-call coverage. Relevant PM, but contrary evidence for the specific no-maintenance-support hypothesis. This does not rule out another use case.
- [Lockwood](https://lockwoodpropertymanagement.com/): identifies a family-operated DFW business managing single-family and multifamily properties. A reasonable fit candidate for further research; door count, staffing, pain and willingness to buy are unknown. Existing emergency dispatch and emphasis on human response must inform outreach.
- [Zanno](https://www.zannopm.com/): Providence-area residential management and visible AppFolio portal links establish geography and software-fit evidence. Staffing pressure and unmet maintenance need remain unknown; existing after-hours contact is not proof of a gap.
- [Green Ocean job overview](https://greenoceanpropertymanagement.com/job-openings): search returned role names, but the direct web read failed. Vacancy status and freshness remain unverified.

No verified active buying trigger was established in these spot checks. Lockwood and Zanno warrant further fit research, not automatic outreach or claims of need.

## Query-level problems

Review of all returned titles, URLs and snippets found marketing aimed at landlords, municipal facilities, housing-authority pages, commercial managers, maintenance-service vendors, job aggregators and wrong-geography firms. Providence queries lacked Rhode Island and matched companies named Providence in other states. Boston fit queries also found large operators and HOA specialists. Coordination queries did not consistently ask for a current job opening.

## Next implementation changes

1. Separate discovery of relevant firms from discovery of dated events. Include explicit state and residential/single-family geography terms.
2. Verify geography and business type before spending on deeper enrichment. Exclude government facilities, repair vendors and commercial-only businesses from this ICP.
3. Require employer-attributed active vacancy evidence and a posting/status check for hiring triggers. Generic career descriptions are context only.
4. Treat small-team/portfolio strain as an evidence hypothesis. Missing staff listings never prove no maintenance support; existing dedicated support is counterevidence to record.
5. Distinguish customer-facing service promises and educational articles from admissions about the firm's own workload.
6. Preserve per-hit source, timestamp, uncertainty and counterevidence. Deduplicate domains/entities and compare against existing CRM firms before admission.
7. Repeat the benchmark with revised, versioned queries before adding the shared PostgreSQL budget reservations and unattended discovery scheduler. No success rate or conversion prediction is justified by this nine-query batch.

## Version 2 live comparison

Nine v2 requests completed without provider errors, using nine more reported credits: 41 hits, 41 distinct URLs, 36 normalized hostname groups. Both batches together used 18 credits. All review groups remained needs_review. Key was used only in process memory and the matching clipboard cleared again.

| Family | DFW | Providence | Boston |
| --- | ---: | ---: | ---: |
| Workflow context | 5 | 5 | 3 |
| Coordination hiring | 5 | 5 | 5 |
| Fit only | 3 | 5 | 5 |

**Reject v2 as an improvement for unattended discovery.** Review of all native result titles/URLs/snippets found all 15 hiring hits unsuitable as attributable PM hiring evidence. Results included dictionaries, health care, financial filings, unrelated municipal documents and a festival. Fit searches also deteriorated: flights, vacation listings, lenders and dumpster services appeared. More returned links did not mean more useful prospects. Query changes are confounded: this batch cannot isolate whether length, exclusions or another provider behavior caused the decline.

Workflow searches retained some relevant firms. Two first-party spot checks through web reads:
- [Heart maintenance](https://www.heartpm.com/maintenance): its emergency instructions use the same published number as its general contact. This is workflow context worth asking about, not proof that an owner answers, lacks coverage or experiences excessive workload. Its visible portal uses Rentvine.
- [Nexus Providence](https://www.nexri.com/providence): confirms Providence-area rental management and states over 600 units with 24-hour maintenance support. Relevant geography, but not evidence of the original two-person/no-support customer pattern.

Recommendation: keep the tested adapter and conservative review policy, but do not schedule these nine queries. Next benchmark should separate short geography-plus-service discovery from source checks on known firm domains. Verify team/portfolio fit first; then inspect that firm's team, maintenance and careers pages for attributed signals and counterevidence. A jobs page should only become a hiring signal after verifying an actual current vacancy. Use the existing shortlist as a comparison baseline. Do not keep expanding a single query with every desired attribute. No candidates or CRM records were created and no outreach was enabled.

## Short firm-first check (v3)

Two Basic calls used the remaining two requests in the 5 October daily allowance. The existing ledger correctly stopped before the Boston query: 20 total requests today, 20 this month. DFW and Providence each returned five results. All ten titles/snippets were recognizable property-management results, unlike v2's unrelated results; this is an analyst relevance assessment, not verified ICP fit or intent. DFW included larger operators and two firms already in the research batch. Providence included franchise operators and firms spanning multiple locations. These results justify a review-only discovery inbox, not automatic qualification. Boston and the suburban rotations remain unevaluated live.

The key was saved directly from the user-authorized clipboard into AWS Secrets Manager `fss-prod/sourcing-search`, encrypted with the existing application KMS key; the matching clipboard was cleared. No key value was written to source, CLI arguments or logs. The secret is not yet connected to production. Terraform must adopt the container before applying this branch's secret wiring. Bootstrap the shared quota with the 20 existing October attempts before enabling, and leave paid overage disabled.
