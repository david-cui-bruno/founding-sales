# Territory clearance: one compliance clearance per state

Status: revision 2, 18 Sep 2026 (design D4, David's decision of 17 Sep 2026; texts corrected after his source check). This is the reading copy. The Settings section renders the same statements and citations from `src/shared/contracts/territoryClearanceContract.ts`; if you edit a statement or a citation here, change the contract and bump `TERRITORY_RULES_REVISION` so a renderer showing older text cannot record a confirmation against the new one.

## What this is for

Before the Mac hands a number to Phone.app, `evaluateOutboundAuthorization` needs a jurisdiction (state, IANA time zone, review date) and a clearance (allowed, registration status confirmed, state do-not-call subscription status confirmed, consent rule confirmed). Until now only the manual citation import wrote those, per route. That cannot scale to thirty new firms a morning.

The clearance is now confirmed once per state. You read the statements below and the quoted passage for each state at its source, tick one disclosure, and click one button. The app writes one revisioned row per state (`territory_clearances`, schema 28) with the confirmation time and a review date one year later. At dial time a listed business phone route without its own hand-cited receipt is authorized against the clearance for the firm's state; the state is read from the firm's Google Places listing (`formattedAddress` in the `place-` source excerpt) and the time zone comes from a fixed map (RI and MA: `America/New_York`; TX: `America/Chicago`). A route that has a receipt keeps using it. Firms whose state has no confirmed clearance stay on Today with the Call control held ("Held: no clearance confirmed for MA"). Firms whose state cannot be read stay `jurisdiction_unknown`, exactly as before.

Nothing in this feature dials, sends or grants anything. Confirming records your statement. The recipient-window rule is unchanged: Monday to Friday, 9:00 to 12:00 and 13:00 to 17:00 in the firm's local time.

## Before you click Confirm

Read every quoted passage at its linked source. Revision 2 of these texts (18 Sep 2026) replaced the first draft after David checked the sources: the first draft's Rhode Island quote did not exist in § 5-61-1, its section numbers for Rhode Island and Massachusetts were wrong, its federal TSR excerpt omitted the proviso, and its Texas summary treated § 302.056 as a general business exemption. The quotes below were copied from the linked pages on 18 Sep 2026; David confirmed the FCC, M.G.L. c. 159C § 1 and Tex. § 302.101 passages as accurate on that date. Every other passage is still to be verified by him at its link. Where a summary asks you to "record", that is your legal position to take (registration, an exemption, or a reading of a definition), not the app's; the app stores the citation and your statements beside each state.

## The statements you confirm (shown once)

1. Business-to-business. These are business-to-business calls placed from my Mac to business numbers that each firm lists publicly for its own business (its Google Business Profile listing or its own website). No residential or personal number is dialed.
2. Registration status checked. I have checked whether my business must register as a telephone solicitor or telemarketer in this state before placing these calls, and my registration status satisfies the rule quoted for the state.
3. State do-not-call subscription checked. I have checked whether this state requires a subscription to its do-not-call list for these calls, and my subscription status satisfies the rule quoted for the state.
4. Consent rule. Consent is never assumed: a request to stop calling is honored at once and recorded, no number with a suppression record is dialed, and calls stay inside the recipient's local business window (Monday to Friday, 9:00 to 12:00 and 13:00 to 17:00).

## Federal basis (read once)

- Telemarketing Sales Rule, 16 CFR 310.6(b)(7). Business-to-business calls are exempt from the Rule, but the exemption keeps two bans in force. Quote: "Telephone calls between a telemarketer and any business to induce the purchase of goods or services or a charitable contribution by the business, provided, however that this exemption does not apply to: (i) The requirements of § 310.3(a)(2) and(4); or (ii) Calls to induce the retail sale of nondurable office or cleaning supplies; provided, however, that §§ 310.4(b)(1)(iii)(B) and 310.5 shall not apply to sellers or telemarketers of nondurable office or cleaning supplies." Source: https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.6
- Telemarketing Sales Rule, 16 CFR 310.3(a)(2) and (a)(4), the parts that still apply to business calls. (a)(2) opens "Misrepresenting, directly or by implication, in the sale of goods or services any of the following material information:" (cost, restrictions, refund terms and the rest of its list). (a)(4) reads: "Making a false or misleading statement to induce any person to pay for goods or services or to induce a charitable contribution." In practice: the one approved product sentence, no pricing claims, no guarantees, on every call and in every template. Source: https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.3
- FCC rules under the TCPA, 47 CFR 64.1200(c)(2). The National Do Not Call Registry protects "A residential telephone subscriber who has registered his or her telephone number on the national do-not-call registry of persons who do not wish to receive telephone solicitations that is maintained by the Federal Government." (Confirmed accurate by David, 18 Sep 2026.) Source: https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200

What the app still does regardless of the clearance: a number with a suppression record (account, person or handle tombstone) never dials; a number the legacy tables mark as federally listed or TCPA-flagged never dials; a number outside the recipient's local window never dials; the excluded-number list (emergency and service codes, short codes, plant-test exchanges, the fictional 555-01XX block) is refused before any handoff.

What the app does not do: it does not scrub the listed business number against the National Do Not Call Registry. The stored contact evidence for a clearance-based route says so honestly (`federalStatus: unknown`, never scrubbed), and the authorization carries an explicit `federalBasis: business_to_business`. A route whose receipt supplies real scrub evidence keeps that evidence and its checks.

## Per state

### Rhode Island (RI), America/New_York

Summary: Rhode Island's Telephone Sales Solicitation Act reaches business calls: § 5-61-1 defines a telephone solicitation as a conversation encouraging "a person" to purchase goods or services, with no consumer limitation. Registration (§ 5-61-3, with the Department of Business Regulation, renewed yearly) attaches to a "telephonic seller" as defined in § 5-61-2(9) unless an exclusion in § 5-61-2(10) applies; none of the listed exclusions plainly covers a first-time business-to-business sale of a service (the ones that mention businesses are prior customers, supervised financial institutions and utilities), so record either your registration or the exclusion you rely on. The do-not-call duty (§ 5-61-3.5) covers residential, mobile and paging numbers, including a firm's listed number when it is a mobile line, and is met by maintaining your own do-not-call list under 47 C.F.R. Part 64 or 16 C.F.R. Part 310 (this app's suppression record). Hours of operation are in § 5-61-3.6.

Citation stored with the confirmation: R.I. Gen. Laws § 5-61-1. Quote to verify: "'Telephone solicitation' means the engagement of a telephone conversation for the purpose of encouraging a person to purchase personal property, investment opportunities, goods or services, or for the purpose of gathering information for sales solicitation." Source: https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-1.htm

Also shown: § 5-61-3 (registration): "Not less than ten (10) days prior to doing business in this state, a telephone sales solicitation operation or telephonic seller shall register with the department" (https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-3.htm); § 5-61-3.5(a) (do not call lists): "No salesperson or telephonic seller shall make, or cause to be made, any unsolicited telephonic sales calls to any residential, mobile, or telephonic-paging-device telephone number unless the salesperson or telephonic seller has instituted procedures for maintaining a list of persons who do not wish to receive telephonic sales calls made by or on behalf of that person, in compliance with 47 C.F.R. Part 64 or 16 C.F.R. Part 310." (https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-3.5.htm); the chapter index for § 5-61-2 (definitions and exclusions) and § 5-61-3.6 (hours): https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/INDEX.htm

### Massachusetts (MA), America/New_York

Summary: Massachusetts General Laws chapter 159C attaches its duties to calls to a "consumer" as defined in § 1: an individual resident of the Commonwealth who is a prospective recipient of consumer goods or services. The no-sales-solicitation-calls listing is § 2 and the calling restrictions, including no calls received between 8:00 p.m. and 8:00 a.m. at the consumer's location, are § 3. The chapter's index shows no telephone-solicitor registration provision (§ 5 concerns marketing-list compilations, § 5A disclosures). Confirm that a call to a firm's listed business number, offering a business service, is outside the § 1 consumer definition, and record where you read it.

Citation stored with the confirmation: M.G.L. c. 159C, § 1. Quote (confirmed accurate by David, 18 Sep 2026): "'Consumer', an individual who is a resident of the commonwealth and a prospective recipient of consumer goods or services." Source: https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section1

Also shown: § 2: "The office shall establish and maintain a no sales solicitation calls listing of consumers who do not wish to receive unsolicited telephonic sales calls." (https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section2); § 3, the hours clause: "to be received between the hours of 8:00 p.m. and 8:00 a.m., local time, at the consumer's location" (https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section3)

### Texas (TX), America/Chicago

Summary: Two Texas chapters apply. Chapter 302 (registration): § 302.101 requires a registration certificate from the Secretary of State for a telephone solicitation to a purchaser located in Texas unless a subchapter B exemption (§§ 302.051 to 302.061) applies. The commercial-sales exemption in § 302.056 covers only purchasers who resell the item or use it in recycling, reuse, remanufacturing or manufacturing, so it does not cover a property management firm buying a service; record the exemption you rely on (read §§ 302.053 to 302.061 yourself: regulated persons, media and catalog sales, nonprofits, food, former or current customers, established retail locations, services for exempt persons, isolated solicitations) or your registration certificate. Chapter 304 (the Texas no-call list): § 304.004(3) excludes calls between a telemarketer and a business unless the business has said it does not want them, and § 304.002 defines a telemarketing call around consumer goods or services; a business's request to stop becomes a suppression record in this app.

Citation stored with the confirmation: Tex. Bus. & Com. Code § 302.101. Quote (confirmed accurate by David, 18 Sep 2026): "A seller may not make a telephone solicitation from a location in this state or to a purchaser located in this state unless the seller holds a registration certificate for the business location from which the telephone solicitation is made." Source: https://tcss.legis.texas.gov/resources/BC/htm/BC.302.htm#302.101

Also shown: § 302.056: "This chapter does not apply to a sale in which the purchaser is a business that intends to: (1) resell the item purchased; or (2) use the item purchased in a recycling, reuse, remanufacturing, or manufacturing process." (https://tcss.legis.texas.gov/resources/BC/htm/BC.302.htm#302.056); § 304.004(3): "This chapter does not apply to a call made: ... (3) between a telemarketer and a business, other than by a facsimile solicitation, unless the business has informed the telemarketer that the business does not wish to receive a telemarketing call from the telemarketer" (https://tcss.legis.texas.gov/resources/BC/htm/BC.304.htm#304.004)

## Adding a state to the territory

Two routes, and they are not alternatives: the control adds the state to the territory, the contract entry is what lets you confirm its clearance.

### From Settings, Territory (the control)

1. Settings, Territory shows the count first: "Territory: 97 firms, 61 not yet called, about 12 new firms a morning at the current pace". The worker counts this on its scheduled tick from its own records; before the first tick, and when the worker's status cannot be read, it says unknown rather than a zero. The estimate spreads the firms nobody has called yet over one business week of mornings and never exceeds the policy's own new-firms-a-day cap. David decides the next state when it falls under 30 a morning (design section 8).
2. "Add a state" offers every United States postal code. The state's time zone comes from `TERRITORY_ADDABLE_STATE_TIME_ZONES` in the contract and from nowhere else, so no calling window is ever computed from a guessed zone. That fixed map holds the New England and Mid-Atlantic states and Texas's four neighbours: CT, ME, NH, VT, NY, NJ, PA, DE, MD, DC, VA and WV on `America/New_York`, NM on `America/Denver`, and OK, AR and LA on `America/Chicago`.
3. A state that observes more than one IANA zone is refused by name with both zones quoted, because a state clearance carries exactly one zone and this build records a firm's state but not its county. The refused states are AK, AZ, FL, ID, IN, KS, KY, MI, NE, NV, ND, OR, SD, TN and TX (`TERRITORY_MULTI_ZONE_STATES`). Texas is already in the territory with `America/Chicago` by David's decision of 17 September 2026; the refusal governs additions and never revokes a state already listed.
4. A state whose zone the build does not record is refused too, with the reason that its zone has to be added to the contract first. Nothing is stored on any refusal.
5. An accepted addition is a revisioned record the worker keeps beside the territory policy (`TERRITORY_ADDED_STATES#<workspaceId>`, compare-and-set on its own revision, idempotent by command id). It never edits `TERRITORY_STATE_TIME_ZONES`.
6. Adding a state changes no Places region. **David's step:** add the state's regions in Settings, Worker connection, Cloud research and press Replace configuration. Until you do, the worker discovers no firms there.
7. The added state appears in Territory clearance as unconfirmed and nothing dials for it: a firm whose listing names a state the built-in map does not hold stays `jurisdiction_unknown` at authorization time.

### In the contract (what lets you confirm it)

1. Add the state and its IANA zone to `TERRITORY_STATE_TIME_ZONES` and a rule entry to `TERRITORY_STATE_RULES`; bump `TERRITORY_RULES_REVISION`.
2. Read the state's own statute at its source and quote the passage. Never draft the summary or the quote from memory.
3. Add the state's section here.
4. The Settings section then lists the state with the same one-click control, its summary and its citation. Firms in that state stay held until you confirm.

## Where things live

- Contract and texts: `src/shared/contracts/territoryClearanceContract.ts`
- Storage: migration `src/main/db/migrations/0028TerritoryClearances.ts`, repository `src/main/domain/compliance/territoryClearanceRepository.ts`
- Derivation (pure): `src/main/domain/compliance/territoryJurisdiction.ts`; used by `createSqlAccountRoutePolicy` in `src/main/domain/accounts/accountOutreach.ts`
- Excluded numbers: `src/main/communications/excludedNumbers.ts` (wired into `startApplication.ts` by the coordinator)
- Settings: `src/renderer/foundation/TerritoryClearanceSection.tsx` and `TerritoryExpansionSection.tsx`, mounted together in `SettingsScreen` under the rail entry "Territory"; IPC `local-workspace:territory-clearance-read|confirm|revoke`
- Territory count and added states: computed by `TerritoryPolicyRepository.computeTerritoryCounts` in `cloud/lambdas/delegated-worker/src/territoryPolicyRepository.ts`, stored under `TERRITORY_COUNTS` once per scheduled tick and reported in the `territory` block of `/research/setup/status`
- Addable zones and refusals (pure): `TERRITORY_ADDABLE_STATE_TIME_ZONES`, `TERRITORY_MULTI_ZONE_STATES` and `decideTerritoryStateAddition` in `src/shared/contracts/territoryClearanceContract.ts`
