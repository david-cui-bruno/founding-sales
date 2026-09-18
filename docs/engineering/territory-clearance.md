# Territory clearance: one compliance clearance per state

Status: drafted 18 Sep 2026 for Batch 7 (design D4, David's decision of 17 Sep 2026). This is the reading copy. The Settings section renders the same statements and citations from `src/shared/contracts/territoryClearanceContract.ts`; if you edit a statement or a citation here, change the contract and bump `TERRITORY_RULES_REVISION` so a renderer showing older text cannot record a confirmation against the new one.

## What this is for

Before the Mac hands a number to Phone.app, `evaluateOutboundAuthorization` needs a jurisdiction (state, IANA time zone, review date) and a clearance (allowed, registration status confirmed, state do-not-call subscription status confirmed, consent rule confirmed). Until now only the manual citation import wrote those, per route. That cannot scale to thirty new firms a morning.

The clearance is now confirmed once per state. You read the statements below and the quoted passage for each state at its source, tick one disclosure, and click one button. The app writes one revisioned row per state (`territory_clearances`, schema 28) with the confirmation time and a review date one year later. At dial time a listed business phone route without its own hand-cited receipt is authorized against the clearance for the firm's state; the state is read from the firm's Google Places listing (`formattedAddress` in the `place-` source excerpt) and the time zone comes from a fixed map (RI and MA: `America/New_York`; TX: `America/Chicago`). A route that has a receipt keeps using it. Firms whose state has no confirmed clearance stay on Today with the Call control held ("Held: no clearance confirmed for MA"). Firms whose state cannot be read stay `jurisdiction_unknown`, exactly as before.

Nothing in this feature dials, sends or grants anything. Confirming records your statement. The recipient-window rule is unchanged: Monday to Friday, 9:00 to 12:00 and 13:00 to 17:00 in the firm's local time.

## Before you click Confirm

Read every quoted passage at its linked source. The quotes below were drafted from the statutes as I remember them; treat them as a reading list, not as verified text, until you have opened each link and checked the words. If a quote is wrong, fix it in the contract (and here) before confirming. Where a summary asks you to "confirm", that is your legal position to take, not the app's.

## The statements you confirm (shown once)

1. Business-to-business. These are business-to-business calls placed from my Mac to business numbers that each firm lists publicly for its own business (its Google Business Profile listing or its own website). No residential or personal number is dialed.
2. Registration status checked. I have checked whether my business must register as a telephone solicitor or telemarketer in this state before placing these calls, and my registration status satisfies the rule quoted for the state.
3. State do-not-call subscription checked. I have checked whether this state requires a subscription to its do-not-call list for these calls, and my subscription status satisfies the rule quoted for the state.
4. Consent rule. Consent is never assumed: a request to stop calling is honored at once and recorded, no number with a suppression record is dialed, and calls stay inside the recipient's local business window (Monday to Friday, 9:00 to 12:00 and 13:00 to 17:00).

## Federal basis (read once)

- Telemarketing Sales Rule, 16 CFR 310.6(b)(7). The Rule exempts "Telephone calls between a telemarketer and any business to induce the purchase of goods or services or a charitable contribution by the business, except calls to induce the retail sale of nondurable office or cleaning supplies". Source: https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-310/section-310.6
- FCC rules under the TCPA, 47 CFR 64.1200(c)(2). The National Do Not Call Registry protects "A residential telephone subscriber who has registered his or her telephone number on the national do-not-call registry of persons who do not wish to receive telephone solicitations that is maintained by the Federal Government." Source: https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200

What the app still does regardless of the clearance: a number with a suppression record (account, person or handle tombstone) never dials; a number the legacy tables mark as federally listed or TCPA-flagged never dials; a number outside the recipient's local window never dials; the excluded-number list (emergency and service codes, short codes, plant-test exchanges, the fictional 555-01XX block) is refused before any handoff.

What the app does not do: it does not scrub the listed business number against the National Do Not Call Registry. The stored contact evidence for a clearance-based route says so honestly (`federalStatus: unknown`, never scrubbed), and the authorization carries an explicit `federalBasis: business_to_business`. A route whose receipt supplies real scrub evidence keeps that evidence and its checks.

## Per state

### Rhode Island (RI), America/New_York

Summary: Rhode Island's Telephone Sales Solicitation Act (R.I. Gen. Laws chapter 5-61) defines a telephonic sales call as a call to a consumer for consumer goods or services, and its registration and no-call duties attach to those calls. Confirm that a call to a property management firm's listed business number, offering a business service, is outside that definition, and record where you read it.

Citation: R.I. Gen. Laws § 5-61-1 (definitions), Telephone Sales Solicitation Act. Quote to verify: "'Telephonic sales call' means a call made by a telephone solicitor to a consumer, for the purpose of soliciting a sale of any consumer goods or services". Source: https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-1.htm

Also read: § 5-61-2 (registration) and § 5-61-3.4 (the state no-call list), in the same chapter index: https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/INDEX.htm

### Massachusetts (MA), America/New_York

Summary: Massachusetts General Laws chapter 159C defines a consumer as a resident of the Commonwealth who is a prospective recipient of consumer goods or services, and its do-not-call list, registration and calling-hour duties attach to telephonic sales calls to consumers. Confirm that a call to a firm's listed business number, offering a business service, is outside that definition, and record where you read it.

Citation: M.G.L. c. 159C, § 1 (definitions). Quote to verify: "'Consumer', an individual who is a resident of the commonwealth and a prospective recipient of consumer goods or services." Source: https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C/Section1

Also read: § 2 (the do-not-call list), § 5 (registration) and § 5A (calling hours) in the same chapter: https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXII/Chapter159C

### Texas (TX), America/Chicago

Summary: Texas Business & Commerce Code chapter 302 requires a registration certificate for telephone solicitations to purchasers in Texas unless an exemption in subchapter B applies, and chapter 304 keeps the Texas no-call list for telemarketing calls to consumers. Confirm which chapter 302 exemption covers your calls to a firm's listed business number (or that you hold the certificate), confirm the chapter 304 position for business numbers, and record where you read it.

Citation: Tex. Bus. & Com. Code § 302.101 (registration certificate required), with the subchapter B exemptions. Quote to verify: "A seller may not make a telephone solicitation from a location in this state or to a purchaser located in this state unless the seller holds a registration certificate for the business location from which the telephone solicitation is made." Source: https://statutes.capitol.texas.gov/Docs/BC/htm/BC.302.htm

Also read: chapter 304 (Texas no-call list), especially the definition of a telemarketing call and the exemptions: https://statutes.capitol.texas.gov/Docs/BC/htm/BC.304.htm

## Adding a state to the territory

1. Add the state and its IANA zone to `TERRITORY_STATE_TIME_ZONES` and a rule entry to `TERRITORY_STATE_RULES` in the contract; bump `TERRITORY_RULES_REVISION`.
2. Add the state's section here.
3. The Settings section lists the new state as unconfirmed with the same one-click control. Firms in that state stay held until you confirm.

## Where things live

- Contract and texts: `src/shared/contracts/territoryClearanceContract.ts`
- Storage: migration `src/main/db/migrations/0028TerritoryClearances.ts`, repository `src/main/domain/compliance/territoryClearanceRepository.ts`
- Derivation (pure): `src/main/domain/compliance/territoryJurisdiction.ts`; used by `createSqlAccountRoutePolicy` in `src/main/domain/accounts/accountOutreach.ts`
- Excluded numbers: `src/main/communications/excludedNumbers.ts` (wired into `startApplication.ts` by the coordinator)
- Settings: `src/renderer/foundation/TerritoryClearanceSection.tsx`, mounted in `SettingsScreen` as "Territory clearance"; IPC `local-workspace:territory-clearance-read|confirm|revoke`
