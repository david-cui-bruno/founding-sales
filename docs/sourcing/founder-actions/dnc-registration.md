# National DNC Registry: Seller registration preparation

**As of October 19, 2026: proposal only. No SAN or registry files have been obtained.** Registry matches and their impact are unknown. This checklist does not register Callie, authorize calls, establish compliance or change any sending/calling control.

## 1. Review the proposed five free area codes before registration

The reviewed, database-only READ ONLY snapshot at **October 19, 2026, 06:19:11.275333 UTC**, schema119, found **33 distinct standing phone-ready firms** in TX/RI/MA. The exact optimal combination of at most five area codes, prioritizing distinct TX firms before RI/MA coverage, was:

| Proposed selection order | Endpoint area code | TX firms covered | RI firms covered |
| --- | --- | --- | --- |
| 1 | **817** | 14 | 0 |
| 2 | **972** | 6 | 0 |
| 3 | **469** | 4 | 1 |
| 4 | **214** | 4 | 0 |
| 5 | **940** | 2 | 0 |

Together these five cover **31 distinct firms: 30 TX and 1 RI**. Outside that combination: **945 covers one additional TX firm; 401 covers one additional RI firm**. MA had **zero** firms in this standing phone-ready census. Do not substitute the former RI/MA geography-based code list or add paid coverage automatically.

Coverage follows the **phone endpoint's area code**, while priority follows the **firm's state**. A RI firm can have a 469 endpoint. Combination scores deduplicate firms across area codes; per-code counts are not generally additive.

### Snapshot scope and limitations

The census included active, assigned firms with active workspace membership, candidate/usable NANP-shaped phone routes, no applicable effective phone/all suppression, a known zone, one currently effective state posture and no applicable dial-authorization hold. It excluded only the exact owner-view fixture name `Callie Internal Test`, not businesses containing “Test”. Closed-only opportunity history was informational, not an invented dial blocker.

This is **standing phone-ready supply ignoring calling hours**, not the useful-brief intersection, current dial permission, verified reachability, line-type proof or registry-safe supply. An area-code shape does not prove a US endpoint. National-registry matches were not available and no new suppression/import/block was performed. Recheck the proposal if the underlying endpoint supply changes before selection. The dated private operational receipt is `dnc119-standing-coverage-20261019-0609-readback.json`; it is not committed here.

## 2. David completes normal Seller registration privately

Primary guidance: [FTC Q&A for telemarketers and sellers about the DNC provisions of the TSR](https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0), checked October 19, 2026. The [official telemarketing registry portal](https://telemarketing.donotcall.gov/) returned a System Error to the research fetch, so these are FTC-documented steps, not a claim that the live form was observed successfully. Stop if the portal differs or requests payment.

- [ ] David reviews the proposed area codes above. No selection/subscription has been submitted.
- [ ] Open the official portal and choose **REGISTER NEW USERS**.
- [ ] Choose **Seller**, calling on its own behalf to sell its own product. Do not choose an exempt-organization shortcut or a telemarketer calling for other sellers.
- [ ] Enter the legal sole-proprietor name **DAVID CUI JR** and **Callie** as DBA if the form provides that field. David personally enters his **EIN, not SSN**, address and contact details in the official form. Do not paste these values into chat, repository files, logs or tickets.
- [ ] Retain the Organization ID privately. Complete the email activation and Representative password setup, and any required authorized-representative/downloader setup. David personally handles verification. Store credentials in his password manager, never the repository.
- [ ] Choose **CREATE NEW SUBSCRIPTION**, then select **individual area codes by area-code number**. Enter only the reviewed five above, not an all-state or all-US selection. The first **five or fewer** area codes are free. Confirm zero charge and stop before any paid selection or payment.
- [ ] Allow up to **one business day** for processing. Retrieve the **SAN from the site**; it is not emailed. Store it privately with the subscription scope/renewal information. SAN issuance alone is not permission to call or evidence of a scrub.

## 3. Written DNC policy and intended refresh cycle

**Accountable owner: David.** The following is the conservative operating policy to complete before registry-backed calling. It is not a claim that automated enforcement exists today.

- Honor internal do-not-call requests **immediately** on the requested number/contact/firm scope through the existing suppression controls. Preserve the suppression history and do not purge stops as ordinary prospect retention cleanup.
- Use registry data **only for permitted compliance purposes**, never as lead supply. Keep access limited to authorized users. Maintain written procedures, relevant caller training and monitoring that checks adherence.
- Compare endpoints against complete data for their subscribed area codes before calling. Registry matches are suppressed conservatively. A company website, business label or claimed business use never overrides a registry match. Unknown line type remains conservative, not presumed to be an exempt business line. These planning counts do not classify line type.
- Use registry data **no more than 31 days old**. This is a freshness requirement, not a 31-day grace period for calling a long-registered number. **Target:** remind David on day28 and refuse calling on stale coverage at day31 until refreshed and re-scrubbed. Uncovered area codes remain outside registry-cleared scope.
- Preserve private download/import receipts, source/version dates, full/delta completeness, area-code coverage, scrub time and results. A fresh subscription or receipt alone does not prove a complete comparison. Do not remove a registry stop merely because a later file is incomplete or stale.
- Anchor the **first** day28 reminder/day31 deadline to the **actual initial complete registry download date**, then maintain it from real refreshes. No initial download date or reminder is invented today, and no calendar task is created by this document.
- Keep national-registry checks separate from state postures, state registration/list obligations, calling hours, assignment, identity, holds and all other restrictions. This checklist provides **no TX, RI or MA state-law clearance**. A recorded posture or apparent B2B context does not replace these checks.

## 4. What remains after SAN issuance

Existing journalled suppression events accept an imported source, and effective phone/all stops are checked by dial advice and ticket authorization/consumption. Refused advice does not emit a `tel:` URI. Those controls do **not** establish that a national registry import or scrub occurred.

**The runtime does not currently provide a complete bulk national-registry importer or automatic subscription-area/registry-age gate.** The day28/day31 and uncovered-area rules above are targets, not shipped fail-closed enforcement. The state-posture selector is separate and does not enforce the registry's 31-day freshness requirement.

After an actual SAN and complete download, a separately reviewed implementation still needs to map the exact covered endpoints, compare registry data, apply matches through the normal suppression path, retain completeness/freshness receipts and enforce stale/out-of-area refusal across relevant calling paths. Unknown line types need conservative treatment. Do not claim current blocked impact, “registered”, “compliant” or “registry-safe” before the corresponding real evidence exists.

No downloads, imports, calendar changes, account creation, new calls or sending activation are performed by this documentation change.
