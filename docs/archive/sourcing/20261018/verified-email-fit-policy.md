# Verified email-fit policy

Implementation policy: `outreach-email-fit-v1`, separate from `qualification-v2` call-first qualification. The approved October 7 roadmap makes public pain optional for email-first outreach. This predicate is not sending authorization or evidence that automatic admission is live.

An email-fit pass requires resolved firm identity, supported residential management in the existing Texas/RI/MA target geography, complete first-party evidence from the firm’s matching website retrieved within seven days, and exactly one supported business email associated with that firm’s office or a source-named person. Consumer mail domains, guessed patterns, unrelated vendors and ambiguous addresses fail the email check. Existing CRM ownership, stops, route validation and deduplication remain separate assessment/admission checks.

A phone and a public maintenance-pain claim are optional. An existing maintenance team or software is context; explicit evidence that the firm does not need maintenance help defers it. Unknown or expired event dates cannot support priority or pain claims: a firm with otherwise verified fit can qualify as fit-only and receive neutral copy. Identity, geography, source completeness and freshness uncertainties are not waived.

`qualifyEmailCandidate` exposes the versioned verdict and supported route. Database assessment exposes `verifiedFit`; the existing manual-dependent admission path still requires its review flag. The next implementation must replace that dependency with an exact-version evaluated automatic policy, bind the active owner/mailbox and approved reusable sequence, and rank eligible prospects before admission. It must not represent automatic selection as a human review, use Key-specific claims for other firms, or bypass stops/validation/capacity/reply ownership.

Tests cover fit without pain, maintenance-team/software context, explicit contrary evidence, stale sources, geography and first-party association, and confirm that the predicate alone does not activate admission. Live source-case evaluation and durable sending verification are still required before activating the autonomous path.

## October 7 stored-source diagnostic

Read-only review of six current production qualification runs matched the predicate: Key Properties and RentProv Realty passed firm/contact evidence; NHS, Nexus, Lyon and Zanno deferred for unsupported identity, contact or source evidence. The Key and RentProv contact pages show bounded company/address/email office cards. RentProv’s published Head of Maintenance is context, not an unmet-need claim. Key is already enrolled and must not be admitted again.

This selected set has two source-reviewed eligible cases and no observed false eligible result. It is too small and selected to estimate population precision or ordinary discovery yield. It does not authorize activation by itself; admission-level ownership, stops, route validation, reusable copy, exact-version evaluation binding and durable sending checks remain required. Local report hash: `1eddab8e90ce6dbd57ca7e9a4258267493c347426c72a5e1ed3ae118b606e246`.
