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
